// /api/proxy-image.js
// Vercel Serverless Function — pobiera obraz produktu po stronie serwera i zwraca go
// jako odpowiedź same-origin, żeby frontend mógł bezpiecznie odczytać jego piksele
// przez canvas.getImageData() (bez tego canvas byłby "tainted" przez CORS przy
// bezpośrednim wczytywaniu obrazów z starecegly.com w trybie precyzyjnego teksturowania).

const ALLOWED_PREFIXES = [
  "https://starecegly.com/"
];

module.exports = async (req, res) => {
  if(req.method !== "GET"){
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Metoda niedozwolona." });
  }

  const url = req.query && req.query.url;
  if(!url || typeof url !== "string"){
    return res.status(400).json({ error: "Brak parametru url." });
  }

  const isAllowed = ALLOWED_PREFIXES.some(prefix => url.startsWith(prefix));
  if(!isAllowed){
    return res.status(403).json({ error: "Niedozwolone źródło obrazu." });
  }

  try{
    const upstream = await fetch(url);
    if(!upstream.ok){
      return res.status(502).json({ error: `Nie udało się pobrać obrazu (${upstream.status}).` });
    }
    const buf = await upstream.arrayBuffer();
    const contentType = upstream.headers.get("content-type") || "image/webp";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).send(Buffer.from(buf));
  }catch(err){
    console.error("Błąd /api/proxy-image:", err);
    return res.status(500).json({ error: "Błąd serwera przy pobieraniu obrazu." });
  }
};
