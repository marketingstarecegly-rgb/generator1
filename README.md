# Wizualizator Stare Cegły

Narzędzie działające analogicznie do wizualizatora RetroCegły
(https://retrocegla.pl/wizualizator), ale pod marką Stare Cegły i podpięte
pod starecegly.com.

## Dwa tryby wizualizacji

### 1. Precyzyjne dopasowanie (domyślny, polecany)
Zamiast prosić AI o „narysowanie cegły od zera", nakłada **prawdziwą teksturę
produktu** ze zdjęcia katalogowego na ścianę, matematycznie korygując
perspektywę na podstawie 4 rogów zaznaczonych przez użytkownika (homografia —
klasyczne „mapowanie kwadratu na czworobok"). Fuga jest renderowana programowo
w dokładnie wybranym kolorze. Efekt: **dokładny kolor i wzór 1:1 z katalogu**,
wynik generowany **natychmiast, w całości w przeglądarce — bez wywołań AI,
bez kosztów, bez limitów zapytań**.

Ograniczenie: obsługuje tylko układ „klasyczne przesunięcie" (running bond)
i „prosty" (bez przesunięcia) — nie obsługuje mieszanki formatów ani jodełki
(te wymagają trybu AI).

### 2. Swobodna wizualizacja AI (dotychczasowy mechanizm)
Generuje obraz przez Gemini 2.5 Flash Image na podstawie opisu produktu.
Obsługuje wszystkie układy (w tym mieszankę i jodełkę), ale wynik to
interpretacja modelu, nie dokładna reprodukcja koloru/faktury — i wymaga
klucza API oraz połączonego billingu Google (koszt ok. 0,04 USD/obraz).

Użytkownik przełącza tryb widocznym segmentowanym przełącznikiem nad
narzędziem.

## Co jest w środku

- `wizualizator.html` — cały frontend (jeden plik). Zawiera oba tryby
  interakcji: zaznaczanie 4 rogów (tryb precyzyjny) oraz malowanie pędzlem
  (tryb AI). Katalog produktów: 83 realne płytki ze starecegly.com w 6
  grupach (Historic Line, Modern Line, Rustic Line, Seria Long, Płytki
  podłogowe i tarasowe).
- `api/generate.js` — funkcja serverless na Vercel, proxy do Gemini 2.5
  Flash Image ("Nano Banana"). Używana wyłącznie w trybie AI.
- `api/proxy-image.js` — funkcja serverless pobierająca zdjęcia produktów
  po stronie serwera. **Niezbędna dla trybu precyzyjnego** — bez niej
  przeglądarka nie mogłaby bezpiecznie odczytać pikseli tekstury produktu
  przez `canvas.getImageData()` (przeglądarki blokują to dla obrazów
  wczytanych bezpośrednio z innej domeny bez nagłówków CORS — tzw. "tainted
  canvas"). Endpoint ogranicza się wyłącznie do adresów zaczynających się
  od `https://starecegly.com/`.
- `logo.png` — logo firmowe używane w topbarze i stopce.

## Jak działa tryb precyzyjny (technicznie)

1. Użytkownik klika 4 rogi fragmentu ściany na zdjęciu (w kolejności: lewy
   górny → prawy górny → prawy dolny → lewy dolny), z możliwością
   przeciągnięcia każdego punktu po umieszczeniu, żeby doprecyzować
   zaznaczenie.
2. Frontend liczy transformację projekcyjną (homografię) mapującą kwadrat
   jednostkowy (0,0)-(1,0)-(1,1)-(0,1) na te 4 punkty.
3. Dla każdego piksela wewnątrz zaznaczonego czworoboku liczona jest
   odwrotność homografii, co daje współrzędne (u,v) w znormalizowanej
   przestrzeni tekstury.
4. Tekstura produktu jest kafelkowana według ustawionej suwakami liczby
   rzędów/kolumn, z opcjonalnym przesunięciem co drugi rząd o pół szerokości
   (running bond) i programowo rysowaną fugą w dokładnie wybranym kolorze.
5. Jasność każdego wygenerowanego piksela jest mnożona przez lokalną
   jasność (luminancję) oryginalnego zdjęcia ściany w tym samym miejscu —
   dzięki temu naturalne cienie i odbicia światła ze zdjęcia są zachowane.
6. Dodawany jest subtelny, deterministyczny szum koloru per cegła (hash
   pozycji rząd/kolumna, ±kilkanaście jednostek RGB), żeby uniknąć
   sztucznie identycznego wyglądu każdej płytki.

Cały proces liczenia dzieje się w przeglądarce (Canvas 2D API — `getImageData`
/ `putImageData`, bez WebGL i bez zewnętrznych bibliotek). Jedyne wywołanie
sieciowe w tym trybie to pobranie tekstury produktu przez `/api/proxy-image`.

## Wdrożenie na Vercel

1. Załóż nowy projekt na vercel.com i wgraj tę zawartość (cały folder,
   łącznie z podfolderem `api/` i plikiem `logo.png`), albo połącz z
   repozytorium GitHub zawierającym te pliki.
2. W **Project Settings → Environment Variables** dodaj (potrzebne tylko
   dla trybu AI — tryb precyzyjny działa bez tego):
   - `GEMINI_API_KEY` = Twój klucz z Google AI Studio (https://aistudio.google.com/apikey)
3. Deploy. Vercel automatycznie rozpozna `api/generate.js` i
   `api/proxy-image.js` jako funkcje serverless (Node.js) i wystawi je pod
   `/api/generate` oraz `/api/proxy-image`.
4. Otwórz `https://twoja-domena.vercel.app/wizualizator.html` — powinno
   działać od razu, domyślnie w trybie precyzyjnym (bez potrzeby klucza API).
5. Docelowo warto podpiąć wizualizator pod subdomenę/ścieżkę na
   starecegly.com (np. `starecegly.com/wizualizator`) — najprościej przez
   CNAME na Vercel albo reverse proxy w Shoperze, jeśli sklep na to pozwala.

## Znane ograniczenia trybu precyzyjnego

- Obsługuje tylko płaskie, w miarę prostokątne fragmenty ściany — mocno
  zakrzywione lub bardzo nieregularne powierzchnie mogą wyglądać gorzej.
- Nie obsługuje układu „naturalna mieszanka" ani „jodełka" (tylko tryb AI).
- Jakość zależy od jakości zdjęcia referencyjnego produktu w katalogu — im
  większe i bardziej reprezentatywne zdjęcie tekstury, tym lepszy wynik.
- Brak wygładzania krawędzi (feather) na granicy zaznaczonego czworoboku —
  precyzyjne zaznaczenie 4 rogów daje najlepszy efekt.

## Co warto dograć później

- **Feather/wygładzenie krawędzi** zaznaczonego obszaru w trybie precyzyjnym
  dla jeszcze bardziej naturalnego przejścia.
- **Podgląd na żywo** siatki kafelkowania podczas przesuwania suwaków
  rzędów/kolumn (obecnie widoczny dopiero po kliknięciu „Uruchom
  wizualizator").
- **Limit zapytań / koszt trybu AI** — warto dodać prosty rate-limiting
  (np. po IP albo captcha) zanim narzędzie trafi na produkcję.
- **Zapis wizualizacji na koncie** — RetroCegła oferuje „zachowaj wizualizację
  po zalogowaniu". To wymaga bazy danych (np. Vercel Postgres / Supabase) i
  integracji z kontem klienta w Shoperze — do zaprojektowania osobno.
- **Wersja niemiecka** — struktura jest gotowa pod i18n; teksty UI są obecnie
  na sztywno po polsku. Dla alteziegel.com trzeba będzie zduplikować plik z
  tłumaczeniem tekstów interfejsu.
