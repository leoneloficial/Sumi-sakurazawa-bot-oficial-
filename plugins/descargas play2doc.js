import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const filePath = path.resolve('./usage.json');
const BLOCKED_FILE = './bloqueados.json';
const TEMP_DIR = path.resolve('./temp_videos');
const MAX_FILE_SIZE = 100 * 1024 * 1024;

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const loadUsage = () => {
  try {
    return JSON.parse(fs.readFileSync(filePath));
  } catch {
    return { descargas: 0, errores: 0 };
  }
};

const saveUsage = (data) => {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
};

const cargarBloqueados = () => {
  try {
    if (fs.existsSync(BLOCKED_FILE)) {
      return JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf-8'));
    }
    fs.writeFileSync(BLOCKED_FILE, JSON.stringify([], null, 2));
    return [];
  } catch (error) {
    console.error('Error al leer bloqueados.json:', error.message);
    return [];
  }
};

const getImageBuffer = async (url) => {
  try {
    const response = await fetch(url, { timeout: 10000 });
    if (!response.ok) throw new Error('No se pudo descargar la imagen');
    return await response.buffer();
  } catch {
    return null;
  }
};

const checkRAMUsage = () => {
  try {
    const data = fs.readFileSync('/proc/meminfo', 'utf8');
    const lines = data.split('\n');
    const totalMem = parseInt(lines.find(line => line.startsWith('MemTotal')).split(/\s+/)[1]);
    const freeMem = parseInt(lines.find(line => line.startsWith('MemFree')).split(/\s+/)[1]);
    const buffers = parseInt(lines.find(line => line.startsWith('Buffers')).split(/\s+/)[1]);
    const cached = parseInt(lines.find(line => line.startsWith('Cached')).split(/\s+/)[1]);
    const availableMem = freeMem + buffers + cached;
    const usedMemPercentage = ((totalMem - availableMem) / totalMem) * 100;
    console.log(`[RAM Debug] Total: ${totalMem} KB, Available: ${availableMem} KB, Used: ${usedMemPercentage.toFixed(2)}%`);
    return usedMemPercentage <= 88;
  } catch (error) {
    console.error('[RAM Debug] Error al leer /proc/meminfo:', error.message);
    return true;
  }
};

const downloadVideoToDisk = async (url, filePath) => {
  try {
    const headResponse = await fetch(url, { method: 'HEAD', timeout: 10000 });
    const contentLength = parseInt(headResponse.headers.get('content-length') || '0');
    if (contentLength > MAX_FILE_SIZE) {
      throw new Error(`El archivo es demasiado grande (${(contentLength / 1024 / 1024).toFixed(2)} MB). Máximo permitido: ${MAX_FILE_SIZE / 1024 / 1024} MB.`);
    }

    const response = await fetch(url, { timeout: 30000 });
    if (!response.ok) throw new Error('No se pudo descargar el video');

    const fileStream = fs.createWriteStream(filePath);
    return new Promise((resolve, reject) => {
      response.body.pipe(fileStream);
      response.body.on('error', (err) => {
        fileStream.close();
        fs.unlink(filePath, () => {});
        reject(err);
      });
      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });
      fileStream.on('error', (err) => {
        fileStream.close();
        fs.unlink(filePath, () => {});
        reject(err);
      });
    });
  } catch (error) {
    throw error;
  }
};

const monitorRAMDuringDownload = async (m, conn, stats) => {
  const interval = setInterval(async () => {
    const ramOk = checkRAMUsage();
    if (!ramOk) {
      clearInterval(interval);
      stats.errores += 1;
      saveUsage(stats);
      await conn.sendMessage(m.chat, { react: { text: "🔴", key: m.key } });
      await conn.sendMessage(m.chat, {
        text: `❌ *Error*: El servidor está usando más del 88% de la RAM. Descarga cancelada.\n\n*Barboza-Bot*`,
        quoted: m
      });
      throw new Error('Uso de RAM excedido');
    }
  }, 5000);
  return interval;
};

let handler = async (m, { conn, text }) => {
  const bloqueados = cargarBloqueados();
  if (bloqueados.includes(m.sender)) return;

  if (!text) {
    return m.reply(
      `❀ Por favor escribe el nombre del video.\n\n> Ejemplo: *video Elionay - Ayúdame A Caminar*\n\n*MediaHub-Bot*`
    );
  }

  const stats = loadUsage();

  if (!checkRAMUsage()) {
    stats.errores += 1;
    saveUsage(stats);
    await conn.sendMessage(m.chat, { react: { text: "🔴", key: m.key } });
    return m.reply(`❌ *Error*: El servidor está usando más del 88% de la RAM. Descarga cancelada.\n\n*Barboza-Bot*`);
  }

  try {
    await conn.sendMessage(m.chat, { react: { text: "📽️", key: m.key } });

    const res = await fetch(`https://api.vreden.my.id/api/ytplaymp4?query=${encodeURIComponent(text)}`, { timeout: 15000 });
    if (!res.ok) throw new Error('Error al conectar con la API');
    const json = await res.json();

    if (!json.result?.metadata?.title || !json.result.download?.url) {
      stats.errores += 1;
      saveUsage(stats);
      await conn.sendMessage(m.chat, { react: { text: "🔴", key: m.key } });
      return m.reply(`❌ No se encontró el video.\n\n*Barboza-Bot*`);
    }

    const info = json.result.metadata;
    const link = json.result.download.url;

    stats.descargas += 1;
    saveUsage(stats);

    const thumbnailUrl = info.thumbnail || info.image || 'https://telegra.ph/file/54f29f75d8b0ca32ddf2c.jpg';
    const imageBuffer = await getImageBuffer(thumbnailUrl);

    const message = {
      text: `
❀ *Video Player* ❀

🎬 *Título:* ${info.title}
⏳ *Duración:* ${info.duration.timestamp}
🎥 *Autor:* ${info.author.name}

✅ *Descargas Globales:* ${stats.descargas}
❌ *Errores Totales:* ${stats.errores}
`.trim(),
      contextInfo: {
        externalAdReply: {
          title: info.title,
          body: info.author.name || 'Barboza-Bot',
          mediaType: 1,
          previewType: 0,
          mediaUrl: link,
          sourceUrl: link,
          thumbnail: imageBuffer || null,
          renderLargerThumbnail: true,
        },
      },
    };

    await conn.sendMessage(m.chat, message, { quoted: m });
    await conn.sendMessage(m.chat, { text: `⬇️ Descargando video...`, quoted: m });

    const ramMonitor = await monitorRAMDuringDownload(m, conn, stats);

    const tempFilePath = path.join(TEMP_DIR, `${Date.now()}_${info.title.replace(/[^a-zA-Z0-9]/g, '_')}.mp4`);
    await downloadVideoToDisk(link, tempFilePath);

    if (!checkRAMUsage()) {
      fs.unlink(tempFilePath, () => {});
      stats.errores += 1;
      saveUsage(stats);
      await conn.sendMessage(m.chat, { react: { text: "🔴", key: m.key } });
      return m.reply(`❌ *Error*: El servidor está usando más del 88% de la RAM. Descarga cancelada.\n\n*Barboza-Bot*`);
    }

    clearInterval(ramMonitor);

    await conn.sendMessage(m.chat, {
      document: fs.readFileSync(tempFilePath),
      mimetype: 'video/mp4',
      fileName: `${info.title}.mp4`
    }, { quoted: m });

    fs.unlink(tempFilePath, (err) => {
      if (err) console.error('Error al eliminar archivo temporal:', err.message);
    });

    await conn.sendMessage(m.chat, { text: `✅ *Su Descarga Fue Exitosa* 🟢`, quoted: m });
    await conn.sendMessage(m.chat, { react: { text: "🟢", key: m.key } });

  } catch (e) {
    console.error('[Error General] ', e);
    stats.errores += 1;
    saveUsage(stats);
    await conn.sendMessage(m.chat, { text: `❌ *Error*: ${e.message || 'Hubo un error en su descarga'} 🔴`, quoted: m });
    await conn.sendMessage(m.chat, { react: { text: "🔴", key: m.key } });
  }
};

handler.help = ['play2 <nombre>'];
handler.tags = ['descargas'];
handler.command = ['play2'];

export default handler;