// /api/generate.js
// Vercel Serverless Function — proxy do Gemini 2.5 Flash Image ("Nano Banana")
// Wymaga zmiennej środowiskowej GEMINI_API_KEY ustawionej w Vercel (Project Settings → Environment Variables).
//
// Limity dziennego generowania (niezalogowani: 1/dzień po IP, zalogowani: 5/dzień po ID klienta)
// wymagają dodatkowo zmiennych UPSTASH_REDIS_REST_URL i UPSTASH_REDIS_REST_TOKEN
// (darmowe konto na https://upstash.com — Redis REST, bez potrzeby żadnej biblioteki npm).
// Jeśli te zmienne nie są ustawione, limity są wyłączone (tryb "fail-open") — narzędzie
// działa normalnie, ale bez ograniczeń liczby generowań.

// Kolejność prób: najpierw nowszy model (lepsze trzymanie się instrukcji wg
// dokumentacji Google), a w razie jego niedostępności (błędny identyfikator,
// model jeszcze nie wdrożony na danym koncie, błąd 400/404) automatyczny
// powrót do sprawdzonego, starszego modelu — żeby awaria nowego modelu nigdy
// nie wyłączyła całego narzędzia.
const GEMINI_MODEL_CANDIDATES = ["gemini-3.1-flash-image", "gemini-2.5-flash-image"];
const GEMINI_ENDPOINT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const LIMIT_ANONYMOUS = 1;
const LIMIT_LOGGED_IN = 5;
const LIMIT_TTL_SECONDS = 26 * 3600; // ok. 26h — margines na strefy czasowe, licznik i tak resetuje się raz na dobę

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function getClientIp(req){
  const fwd = req.headers["x-forwarded-for"];
  if(fwd) return String(fwd).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

async function upstashCommand(pathSegments){
  const url = `${UPSTASH_URL}/${pathSegments.map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
  if(!res.ok) throw new Error(`Upstash error ${res.status}`);
  return res.json();
}

// Sprawdza i zwiększa licznik generowań dla danego klucza. Zwraca informację,
// czy żądanie mieści się w dziennym limicie.
async function checkAndIncrementLimit(key, limit){
  if(!UPSTASH_URL || !UPSTASH_TOKEN){
    // Brak konfiguracji Redis — limity wyłączone (fail-open), narzędzie działa bez ograniczeń.
    return { allowed: true, remaining: null, configured: false };
  }
  try{
    const incrData = await upstashCommand(["incr", key]);
    const count = incrData.result;
    if(count === 1){
      // pierwsze użycie w tym okresie rozliczeniowym — ustaw wygaśnięcie klucza
      await upstashCommand(["expire", key, String(LIMIT_TTL_SECONDS)]);
    }
    if(count > limit){
      return { allowed: false, remaining: 0, count, configured: true };
    }
    return { allowed: true, remaining: limit - count, count, configured: true };
  }catch(err){
    console.error("Błąd limitowania (Upstash):", err);
    // W razie awarii usługi limitów nie blokujemy generowania (fail-open).
    return { allowed: true, remaining: null, configured: true, error: true };
  }
}

const SURFACE_LABELS = {
  "elewacja": "elewację budynku (zewnętrzną ścianę)",
  "sciana-wewnetrzna": "wewnętrzną ścianę pomieszczenia",
  "kominek": "obudowę kominka lub zabudowę",
  "inna": "wskazaną powierzchnię"
};

const LAYOUT_LABELS = {
  "klasyczne-przesuniecie": "klasyczny układ z przesunięciem (running bond) — Płytki ceglane ułożone poziomo w klasycznym, mijankowym układzie ceglanym. Każda płytka ma dłuższy bok ustawiony poziomo. Kolejne rzędy są przesunięte względem siebie o około połowę długości płytki, dzięki czemu pionowe spoiny nie znajdują się w jednej linii, lecz mijają się w każdym kolejnym rzędzie. Układ tworzy charakterystyczny rytm tradycyjnego muru ceglanego. Regularne poziome rzędy, równomierne spoiny i powtarzalny wzór bez przerw i przypadkowych przesunięć.",
  "prosty": "prosty układ siatkowy (stack bond) — Płytki ceglane ułożone poziomo, w równoległych, regularnych rzędach. Wszystkie płytki mają dłuższy bok ustawiony poziomo. Pionowe spoiny przebiegają w jednej linii przez całą powierzchnię, tworząc regularną siatkę prostokątnych pól. Kolejne rzędy nie są przesunięte względem siebie. Układ jest całkowicie prosty i symetryczny, bez mijania się spoin pionowych. Płytki są oddzielone wyraźnymi, równymi spoinami poziomymi i pionowymi.",
  "pionowy": "pionowy układ (vertical/stretcher bond) — Płytki ceglane ułożone pionowo, dłuższym bokiem w kierunku pionowym, w regularnych poziomych rzędach. Każdy rząd składa się z wąskich, wydłużonych prostokątnych płytek ustawionych jedna obok drugiej. Pionowe spoiny są przesunięte względem sąsiednich rzędów, tworząc naprzemienny układ. To jest fundamentalnie inny układ niż domyślny — pamiętaj że cegły mają być PIONOWO ustawione, a nie jak zwykle poziomo.",
  "jodelka": "UKŁAD W JODEŁKĘ (herringbone) — Płytki ceglane ułożone w klasyczny wzór jodełki. Wąskie, wydłużone prostokątne płytki są układane naprzemiennie pod kątem 45° lub 90°, tak że krótszy bok jednej płytki styka się z dłuższym bokiem kolejnej. Płytki tworzą powtarzalny zygzakowaty wzór w kształcie litery V, biegnący przez całą powierzchnię. Zachowane regularne odstępy między płytkami i wyraźne spoiny. Każdy element jest precyzyjnie ustawiony względem poprzedniego, tworząc charakterystyczny rytm jodełki.. Jeśli wynik pokazuje zwykłe poziome rzędy cegieł, to jest BŁĄD."
};

const MORTAR_COLOR_LABELS = {
  "biala": "biała (czysta, jasna, jasnoszaro-biała fuga betonowa, wyraźnie jaśniejsza niż otaczające płytki)",
  "stara-biel": "stara biel (przygaszona, lekko szarawa biel z delikatnym beżowym odcieniem, jak stary, naturalnie zabrudzony beton)",
  "piaskowa": "piaskowa (ciepły, beżowo-piaskowy odcień, zbliżony do koloru piasku lub jasnego beżu)",
  "szara": "szara (średni, stonowany szary, wyraźnie ciemniejszy niż biała czy piaskowa fuga)",
  "antracytowa": "antracytowa (bardzo ciemny, prawie czarny odcień antracytu — wyraźnie ciemniejsza niż płytki)"
};

function dataUrlToInlineData(dataUrl){
  const match = /^data:(image\/[a-zA-Z]+);base64,(.+)$/.exec(dataUrl || "");
  if(!match) return null;
  return { mimeType: match[1], data: match[2] };
}

async function fetchImageAsInlineData(url){
  const res = await fetch(url);
  if(!res.ok) throw new Error(`Nie udało się pobrać obrazu produktu (${res.status})`);
  const buf = await res.arrayBuffer();
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const base64 = Buffer.from(buf).toString("base64");
  return { mimeType: contentType.split(";")[0], data: base64 };
}

module.exports = async (req, res) => {
  if(req.method !== "POST"){
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Metoda niedozwolona." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if(!apiKey){
    return res.status(500).json({ error: "Brak skonfigurowanego klucza GEMINI_API_KEY na serwerze." });
  }

  try{
    const {
      originalImage,
      highlightedImage,
      productName,
      productDescription,
      productDims,
      productShapeHint,
      productAspectRatio,
      productImage,
      productTextureDetails,
      productColorPalette,
      productMaterialsInfo,
      surface,
      layout,
      mount,
      mortarColor,
      customerId
    } = req.body || {};

    // ---- limit dziennych generowań ----
    const isLoggedIn = !!(customerId && String(customerId).trim());
    const identity = isLoggedIn ? `cust:${String(customerId).trim()}` : `ip:${getClientIp(req)}`;
    const limit = isLoggedIn ? LIMIT_LOGGED_IN : LIMIT_ANONYMOUS;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const rlKey = `wizualizator:${identity}:${today}`;

    const rl = await checkAndIncrementLimit(rlKey, limit);
    if(!rl.allowed){
      return res.status(429).json({
        error: isLoggedIn
          ? `Wykorzystałeś dzienny limit ${LIMIT_LOGGED_IN} generowań na dziś. Wróć jutro, żeby stworzyć kolejne wizualizacje.`
          : `Wykorzystałeś swoją bezpłatną, jednorazową wizualizację na dziś. Zaloguj się na swoje konto na starecegly.com, żeby mieć dostęp do ${LIMIT_LOGGED_IN} generowań dziennie.`,
        limitReached: true,
        loggedIn: isLoggedIn
      });
    }

    if(!originalImage || !highlightedImage || !productName){
      return res.status(400).json({ error: "Brak wymaganych danych wejściowych (zdjęcie, zaznaczenie lub produkt)." });
    }

    const originalInline = dataUrlToInlineData(originalImage);
    const highlightedInline = dataUrlToInlineData(highlightedImage);
    if(!originalInline || !highlightedInline){
      return res.status(400).json({ error: "Nieprawidłowy format przesłanego zdjęcia." });
    }

    let productInline = null;
    if(productImage){
      try{
        productInline = await fetchImageAsInlineData(productImage);
      }catch(e){
        productInline = null; // kontynuuj bez wzorca wizualnego, opieramy się na opisie tekstowym
      }
    }

    const surfaceLabel = SURFACE_LABELS[surface] || "wskazaną powierzchnię";
    const layoutLabel = LAYOUT_LABELS[layout] || "naturalny układ";
    const mortarColorLabel = MORTAR_COLOR_LABELS[mortarColor] || MORTAR_COLOR_LABELS["biala"];

    const mountLine = mount === "bez-fugi"
      ? "Montaż BEZ FUGI: płytki ułożone ściśle przy sobie, bez żadnych widocznych spoin ani przerw między płytkami."
      : "Montaż Z FUGĄ: między płytkami musi być wyraźnie widoczna spoina o szerokości ok. 1–1.5 cm.";

    const mortarColorLine = mount === "bez-fugi"
      ? ""
      : `\n- KOLOR FUGI (bardzo ważne, zastosuj dokładnie): fuga musi mieć kolor ${mortarColorLabel}. To kluczowy parametr — nie zastępuj go domyślnym ani innym odcieniem.`;

    // Fallback: jeśli produkt nie ma ręcznie ustawionego aspectRatio/shapeHint,
    // spróbuj wyliczyć proporcję wprost z tekstu productDims (np. "proporcje ok. 3,7:1"
    // lub "proporcje ok. 8,3–9:1"). Dzięki temu każdy produkt o wyraźnie wydłużonym
    // formacie dostaje pełny alert kształtu, nawet jeśli w katalogu zabrakło dla niego
    // dedykowanych pól aspectRatio/shapeHint.
    function extractRatioFromDims(dims){
      if(!dims) return null;
      const m = String(dims).match(/proporcj[ea]\s*ok\.?\s*([\d.,]+)(?:\s*[–-]\s*([\d.,]+))?\s*:\s*1/i);
      if(!m) return null;
      const a = parseFloat(m[1].replace(",", "."));
      if(isNaN(a)) return null;
      const b = m[2] ? parseFloat(m[2].replace(",", ".")) : a;
      return isNaN(b) ? a : (a + b) / 2;
    }

    const SHAPE_ALERT_MIN_RATIO = 2.3; // wyraźnie powyżej standardowej cegły (~2:1)

    const explicitAspectRatio = (productAspectRatio && Number(productAspectRatio) > 0)
      ? Number(productAspectRatio)
      : null;
    const derivedAspectRatio = explicitAspectRatio || extractRatioFromDims(productDims);
    const effectiveAspectRatio = derivedAspectRatio && derivedAspectRatio >= SHAPE_ALERT_MIN_RATIO
      ? derivedAspectRatio
      : null;

    const ratioMultiplier = effectiveAspectRatio
      ? (effectiveAspectRatio / 2).toFixed(1)
      : null;

    const effectiveShapeHint = productShapeHint
      || (effectiveAspectRatio
        ? `Format tej płytki wyraźnie odbiega od standardowej cegły: proporcja długość:wysokość to ok. ${effectiveAspectRatio.toFixed(1)}:1 (dla porównania zwykła cegła budowlana ma ok. 2:1), zgodnie z wymiarami: ${productDims}. Moduł jest więc wyraźnie bardziej wydłużony i płaski niż typowa cegła — na tej samej wysokości ściany zmieści się wyraźnie więcej wąskich, poziomych rzędów niż przy zwykłej cegle.`
        : null);

    const dimsLine = productDims
      ? `\n- WYMIARY I PROPORCJE POJEDYNCZEJ PŁYTKI (krytycznie ważne, zastosuj dokładnie): ${productDims}. NIE renderuj standardowych proporcji cegły (ok. 2:1) — moduł MUSI być wyraźnie bardziej wydłużony i płaski, zgodnie z podanymi proporcjami${ratioMultiplier ? ` (to ok. ${ratioMultiplier}× smuklejszy moduł niż zwykła cegła 2:1 — NIE o kilkanaście procent, tylko wielokrotnie bardziej wydłużony i wielokrotnie niższy)` : ""}. To najczęstszy błąd do uniknięcia: zbyt "kwadratowe" lub zbyt wysokie płytki są NIEPOPRAWNE dla tego produktu.`
      : "";

    const shapeAlert = effectiveShapeHint
      ? `UWAGA — NIETYPOWY FORMAT PŁYTKI, PRZECZYTAJ PRZED WYKONANIEM ZADANIA:
Ten produkt NIE ma proporcji zwykłej cegły. ${effectiveShapeHint}${ratioMultiplier ? ` Liczbowo: pojedynczy moduł jest ok. ${ratioMultiplier} razy bardziej wydłużony (proporcja długość:wysokość) niż standardowa cegła 2:1 — to znacząca, łatwo zauważalna różnica, nie subtelna korekta.` : ""} Jeśli narysujesz moduły o standardowych proporcjach cegły (ok. 2:1), wynik będzie BŁĘDNY — musi być wyraźnie więcej wąskich, poziomych rzędów niż w typowym murze z cegły.
PRIORYTET ŹRÓDŁA PRAWDY O KSZTAŁCIE: opis proporcji podany wyżej jest NADRZĘDNY wobec załączonego zdjęcia referencyjnego produktu. Zdjęcie referencyjne służy WYŁĄCZNIE jako wzorzec koloru, faktury i charakteru materiału — CAŁKOWICIE ZIGNORUJ proporcje/kształt pojedynczej cegły widoczne na tym zdjęciu, nawet jeśli kadr sugeruje bardziej "zwykłe" proporcje (np. przez przybliżenie, kąt kadrowania lub obcięcie). Kształtem rządzi wyłącznie opis tekstowy powyżej.
WAŻNE: mimo wydłużonego formatu, cała zaznaczona powierzchnia MA WYGLĄDAĆ JAK JEDNOLITA OKŁADZINA Z PŁYTEK — tak jak każda inna cegła na tej ścianie. NIE dodawaj żadnych ramek, obwódek, listew wykończeniowych, podziałów na panele/sekcje ani żadnych elementów, o które nie proszono. To ma być zwykła, ciągła okładzina ceglana, tylko z płytkami o innych proporcjach.

`
      : "";

    const layoutAlert = (layout === "jodelka" || layout === "mieszanka" || layout === "pionowy")
      ? `UWAGA — NIESTANDARDOWY UKŁAD UŁOŻENIA CEGŁY, PRZECZYTAJ PRZED WYKONANIEM ZADANIA:
Użytkownik wybrał układ: ${layoutLabel}
Załączone zdjęcie referencyjne produktu prawdopodobnie pokazuje cegłę ułożoną w zwykły, poziomy sposób (running bond) — to zdjęcie ma służyć WYŁĄCZNIE jako wzorzec KOLORU, FAKTURY i CHARAKTERU materiału. CAŁKOWICIE ZIGNORUJ sposób ułożenia/wzór widoczny na tym zdjęciu referencyjnym. Układ ułożenia na finalnym obrazie musi być zgodny wyłącznie z opisem: ${layoutLabel}. Jeśli wynik będzie pokazywał zwykłe poziome rzędy zamiast opisanego układu, to jest BŁĄD — sprawdź to przed zakończeniem generowania.

`
      : "";

    const promptParts = [];

    promptParts.push({
      text:
`${shapeAlert}${layoutAlert}Jesteś precyzyjnym narzędziem do fotorealistycznej wizualizacji materiałów budowlanych na zdjęciach architektonicznych. Twoje zadanie to KLUCZOWE — każdy szczegół liczy się do dokładności wynikowego obrazu.

Otrzymujesz dwa zdjęcia:
1. Oryginalne zdjęcie ściany/elewacji.
2. To samo zdjęcie z obszarem podświetlonym na pomarańczowo-czerwono (kolor nakładki: rgba(217,103,63)) — ten podświetlony obszar precyzyjnie wskazuje, KTÓRY fragment ściany ma zostać przebudowany.

INSTRUKCJE DOTYCZĄCE KOLORU I FAKTURY (KRYTYCZNE):
- KOLOR: Dopasuj barwę DOKŁADNIE do załączonego zdjęcia referencyjnego produktu. Obserwuj wszystkie odcienie, zciemnienia, plamki, nieregularności kolorystyczne widoczne na referencji. Jeśli płytki mają naturalną zmienność — zachowaj ją. Jeśli są jednolite — nie dodawaj sztucznych wariacji.
- TEKSTURA POWIERZCHNI: Zdjęcie referencyjne pokazuje DOKŁADNIE jak powinna wyglądać tekstura materiału. Analizuj: czy powierzchnia jest gładka/chropowata, czy widać pory, rysy, ziarnistość, czy są szczegóły — i odtwórz to z wierności fotorealistycznej.
- FAKTYCZNE DETALE: Jeśli na referencji widzisz naturalne zabrudzenia, przebarwienia, nierówności powierzchni — to są CECHY PRODUKTU, zintegruj je. To nie są błędy — to właśnie charakterystyka materiału.
- BRAK UPROSZCZENIA: Nie idealizuj — jeśli materiał ma szorstką, nieregularną fakturę, musi być wyraźnie szorstki. Jeśli ma pory — muszą być widoczne.

Twoje zadanie:
Zastąp WYŁĄCZNIE podświetlony obszar realistyczną okładziną z płytek z cegły "${productName}". Opis materiału: ${productDescription || "płytka z cegły o naturalnej, nieregularnej fakturze"}.
${productTextureDetails ? `\nDETALI TEKSTURY (BARDZO WAŻNE, przeczytaj uważnie): ${productTextureDetails}` : ""}
${productColorPalette ? `\nPALETA KOLORÓW (KRYTYCZNE dla dokładności): ${productColorPalette}` : ""}
${productMaterialsInfo ? `\nINFORMACJE O MATERIALE: ${productMaterialsInfo}` : ""}
${productInline ? "Dołączam też osobne zdjęcie referencyjne samego materiału/tekstury — dopasuj DOKŁADNIE kolor, fakturę, detale i charakter cegły do tego wzorca. To zdjęcie jest KLUCZOWE." : ""}

Zastosuj dokładnie następujące parametry:
- Powierzchnia: ${surfaceLabel}.
- Układ cegły: ${layoutLabel}.
- ${mountLine}${mortarColorLine}${dimsLine}

Zasady krytyczne:
- Usuń całkowicie pomarańczową nakładkę z wyniku — finalny obraz ma wyglądać jak naturalna, niezmodyfikowana fotografia, BEZ śladu podświetlenia.
- Zachowaj dokładnie oryginalną perspektywę, kąt kamery, proporcje budynku oraz wszystkie elementy poza zaznaczonym obszarem (okna, drzwi, rynny, otoczenie, niebo, oświetlenie) bez zmian.
- Dopasuj cień, kierunek światła i odbicia na nowej okładzinie tak, by pasowały do oświetlenia sceny na oryginalnym zdjęciu. WAŻNE: zwróć uwagę na KIERUNEK światła, INTENSYWNOŚĆ cieni i ODBICIA na referencyjnym zdjęciu produktu.
- Zachowaj naturalne, realistyczne przejścia na krawędziach zaznaczonego obszaru — bez twardych, sztucznych linii cięcia.
- Cała zaznaczona powierzchnia ma być pokryta JEDNOLITĄ okładziną — bez ramek, obwódek, listew, podziału na panele lub sekcje, chyba że wynika to wyłącznie z naturalnego układu płytek opisanego wyżej.
- KRYTYCZNE — BRAK BIAŁYCH/JASNYCH OBWÓDEK WOKÓŁ OTWORÓW: jeśli w zaznaczonym obszarze znajdują się okna, drzwi lub inne otwory, okładzina z cegły MUSI sięgać dokładnie do ich krawędzi (do ramy okna/drzwi), bez żadnego niepomalowanego, jasnego, białego lub pustego paska/obwódki pozostawionego między cegłą a otworem. To bardzo częsty błąd do uniknięcia — sprawdź dokładnie każdą krawędź otworu w zaznaczonym obszarze przed zakończeniem generowania. Jedyna dozwolona "ramka" to prawdziwa, fizyczna framuga/ościeżnica okna lub drzwi, jeśli była widoczna na oryginalnym zdjęciu — nic ponad to.
- SPÓJNOŚĆ TEKSTURY NA CAŁEJ POWIERZCHNI: każda pojedyncza cegła i każda spoina w zaznaczonym obszarze musi być wyraźna, ostra i spójna z resztą okładziny — bez lokalnych rozmyć, zniekształceń, "poszarpanych" fragmentów, zlewających się ze sobą cegieł ani innych lokalnych artefaktów. Jeśli jakikolwiek pojedynczy fragment (nawet mały) odbiega jakością lub wyrazistością od reszty wygenerowanej okładziny, popraw go tak, żeby pasował do reszty przed zwróceniem wyniku.
- ROZMIARY PŁYTEK: Cegły w zaznaczonym obszarze muszą mieć REALISTYCZNE proporcje. Sprawdź: czy są drażniąco duże, czy drażniąco małe względem reszty sceny? Porównaj ze zdjęciem referencyjnym — tam widzisz jak duże powinny być w stosunku do detali otoczenia. Jeśli wygenerujesz płytki zbyt duże lub zbyt małe, wynik będzie nieprzekonujący.
- Nie dodawaj znaków wodnych, tekstu ani elementów graficznych spoza sceny.
- Wygeneruj wyłącznie finalny, fotorealistyczny obraz wynikowy.

PODSUMOWANIE — sprawdź przed wygenerowaniem, że wynik spełnia WSZYSTKIE poniższe punkty:
1. Produkt: ${productName} (${productDescription || "naturalna faktura cegły"}).
2. Kolor dopasowany DOKŁADNIE do zdjęcia referencyjnego (sprawdź odcienie, zaciemnienia, plamki, wszystkie detale kolorystyczne).
3. Tekstura jest wiernie odtworzona — nie uproszczona, nie wyglądająca "czysto" jeśli materiał jest szorstki.
4. Układ: ${layoutLabel}.${(layout === "jodelka" || layout === "mieszanka" || layout === "pionowy") ? " Sprawdź jeszcze raz: to NIE ma być zwykły poziomy układ z przesunięciem, nawet jeśli zdjęcie referencyjne produktu tak sugeruje." : ""}
5. ${mount === "bez-fugi" ? "Brak fugi między płytkami." : `Fuga WIDOCZNA, w kolorze: ${mortarColorLabel}.`}
6. Brak białych/jasnych, niepomalowanych obwódek wokół okien, drzwi lub innych otworów w zaznaczonym obszarze — cegła sięga dokładnie do ich krawędzi.
7. Rozmiary płytek są realistyczne i proporcjonalne do otoczenia.
8. Tekstura na całej powierzchni jest spójna, ostra i czyszczna — bez rozmyć i artefaktów.
${productDims ? `9. Proporcje pojedynczej płytki: ${productDims}${effectiveShapeHint ? ` — ${effectiveShapeHint}` : ""}.\n10. Jednolita okładzina bez dodatkowych ramek/podziałów.\n11. Reszta zdjęcia (poza zaznaczonym obszarem) bez zmian.` : "9. Jednolita okładzina bez dodatkowych ramek/podziałów.\n10. Reszta zdjęcia (poza zaznaczonym obszarem) bez zmian."}`
    });

    promptParts.push({ text: "Zdjęcie oryginalne:" });
    promptParts.push({ inlineData: originalInline });
    promptParts.push({ text: "Zdjęcie z podświetlonym obszarem do przemiany:" });
    promptParts.push({ inlineData: highlightedInline });
    if(productInline){
      const shapeReminder = effectiveShapeHint
        ? ` Przypomnienie: to zdjęcie pokazuje WYŁĄCZNIE kolor i fakturę — kształt/proporcje pojedynczej cegły bierz TYLKO z opisu tekstowego wyżej (${productDims || effectiveShapeHint}), nie z tego kadru.`
        : "";
      promptParts.push({ text: `Referencyjna tekstura produktu "${productName}":${shapeReminder}` });
      promptParts.push({ inlineData: productInline });
    }

    const geminiRequest = {
      contents: [{ role: "user", parts: promptParts }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
    };

    let geminiRes = null;
    let usedModel = null;
    let lastErrorText = "";

    for(const modelId of GEMINI_MODEL_CANDIDATES){
      const attemptRes = await fetch(`${GEMINI_ENDPOINT_BASE}/${modelId}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiRequest)
      });

      if(attemptRes.ok){
        geminiRes = attemptRes;
        usedModel = modelId;
        break;
      }

      lastErrorText = await attemptRes.text().catch(() => "");
      console.error(`Gemini API error dla modelu ${modelId}:`, attemptRes.status, lastErrorText);

      // Jeśli błąd NIE wygląda na "model nieznaleziony/niedostępny" (np. limit,
      // zła treść promptu), nie ma sensu próbować kolejnego modelu — przerwij.
      const looksLikeModelIssue = attemptRes.status === 404 || attemptRes.status === 400;
      if(!looksLikeModelIssue) break;
    }

    if(!geminiRes){
      return res.status(502).json({ error: `Błąd generatora obrazu. Spróbuj ponownie.` });
    }

    const geminiData = await geminiRes.json();
    const parts = geminiData?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData && p.inlineData.data);

    if(!imagePart){
      console.error("Brak obrazu w odpowiedzi Gemini:", JSON.stringify(geminiData).slice(0, 800));
      return res.status(502).json({ error: "Generator nie zwrócił obrazu. Spróbuj z innym zdjęciem lub zaznaczeniem." });
    }

    const mime = imagePart.inlineData.mimeType || "image/png";
    const b64 = imagePart.inlineData.data;

    return res.status(200).json({
      image: `data:${mime};base64,${b64}`,
      remaining: rl.remaining,
      limit: limit,
      loggedIn: isLoggedIn,
      modelUsed: usedModel
    });

  }catch(err){
    console.error("Błąd /api/generate:", err);
    return res.status(500).json({ error: "Wewnętrzny błąd serwera." });
  }
};
