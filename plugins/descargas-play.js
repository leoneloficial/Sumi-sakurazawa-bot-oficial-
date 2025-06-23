import fetch from "node-fetch";
import yts from "yt-search";


const encodedApi = "aHR0cHM6Ly9hcGkudnJlZGVuLndlYi5pZC9hcGkveXRtcDM=";


const getApiUrl = () => Buffer.from(encodedApi, "base64").toString("utf-8");

const fetchWithRetries = async (url, maxRetries = 2) => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url);
      const data = await response.json();
      if (data?.status === 200 && data.result?.download?.url) {
        return data.result;
      }
    } catch (error) {
      console.error(`Intento ${attempt + 1} fallido:`, error.message);
    }
  }
  throw new Error("No se pudo obtener la música después de varios intentos.");
};


let handler = async (m, { conn, text }) => {
  if (!text || !text.trim()) {
    return conn.sendMessage(m.chat, {
      text: "*✎ ingresa el nombre de la música a descargar.*`\n\n*Ejemplo:* `.play No llores más`",
    });
  }

  try {
    await conn.sendMessage(m.chat, { react: { text: "", key: m.key } });

    const searchResults = await yts(text.trim());
    const video = searchResults.videos[0];
    if (!video) throw new Error("No se encontraron resultados.");

    const apiUrl = `${getApiUrl()}?url=${encodeURIComponent(video.url)}`;
    const apiData = await fetchWithRetries(apiUrl);

    await conn.sendMessage(m.chat, {
      image: { url: video.thumbnail },
      caption: `*「✦」descargando ${video.title}*

> ✦ Canal » *${video.author.name}*\n> ✰ *Vistas:* » ${video.views}\n> ⴵ *Duración:* » ${video.timestamp}\n> ✐  *Autor:* » ${video.author.name}`,

 
   });

    const audioMessage = {
      audio: { url: apiData.download.url },
      mimetype: "audio/mpeg",
      fileName: `${video.title}.mp3`,
    };

    await conn.sendMessage(m.chat, audioMessage, { quoted: m });
    await conn.sendMessage(m.chat, { react: { text: "✅", key: m.key } });
  } catch (error) {
    console.error("Error:", error);
    await conn.sendMessage(m.chat, { react: { text: "❌", key: m.key } });
    await conn.sendMessage(m.chat, {
      text: `❌ *Error al procesar tu solicitud:*\n${error.message || "Error desconocido"}`,
    });
  }
};

handler.command = ['playaudio','mp3',]; // Puedes usar ['play', 'tocar'] si quieres más alias
handler.help = ['playaudio <texto>','mp3',];
handler.tags = ['downloader'];

export default handler;