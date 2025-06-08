import fetch from 'node-fetch'

let handler = async (m, { conn, args, text }) => {
  if (!args[0]) throw m.reply('Proporcione una consulta');
  const sender = m.sender.split('@')[0];

let ouh = await fetch(`https://fastrestapis.fasturl.cloud/downup/ytdown-v1?name=${text}&format=mp4&quality=720&server=auto`)
  let gyh = await ouh.json()
  const { duration, thumbnail, views, description, lengthSeconds, uploadDate } = gyh.result.metadata
  const { author, name, bio, image, subCount } = gyh.result.author
  const { url, format, quality, media, title } = gyh.result

  m.reply(wait);
let textcap = `*YOUTUBE VIDEO DOWNLOADER*

# Titulo: ${title}
# Duración: ${lengthSeconds}
# Calidad: ${quality}

  //_*Descripción:*_
  
  //${description}

//> ${wm}`
//await conn.sendMessage(
        m.chat,
        {
          video: { url: media },
          mimetype: 'video/mp4',
          fileName: 'video.mp4',
          caption: textcap,
          mentions: [m.sender],
        },
        { quoted: m }
      );

};

handler.help = ['playvideo <consulta>'];
handler.tags = ['downloader'];
handler.command = ["playvideo"];

export default handler