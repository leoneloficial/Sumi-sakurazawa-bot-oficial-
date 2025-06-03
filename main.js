import "./config.js"
import { createRequire } from "module"
import path, { join } from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { platform } from "process"
import { readdirSync, statSync, unlinkSync, existsSync, watchFile } from "fs"
import yargs from "yargs"
import lodash from "lodash"
import chalk from "chalk"
import syntaxerror from "syntax-error"
import { tmpdir } from "os"
import { format } from "util"
import { makeWASocket, protoType, serialize } from "./lib/simple.js"
import { Low, JSONFile } from "lowdb"
import pino from "pino"
import { mongoDB, mongoDBV2 } from "./lib/mongoDB.js"
import store from "./lib/store.js"
import readline from "readline"
import fs from "fs"
import { spawn } from "child_process"

const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  Browsers,
} = await import("@whiskeysockets/baileys")

import NodeCache from "node-cache"

const { chain } = lodash
const PORT = process.env.PORT || process.env.SERVER_PORT || 3000

class BotRestartManager {
  constructor() {
    this.restartCount = 0
    this.maxRestarts = 10
    this.restartCooldown = 5000
    this.lastRestart = 0
    this.criticalErrors = new Set([
      'ECONNRESET',
      'ENOTFOUND',
      'ETIMEDOUT',
      'ECONNREFUSED'
    ])
  }

  shouldRestart(error) {
    const now = Date.now()
    
    if (now - this.lastRestart < this.restartCooldown) {
      return false
    }

    if (this.restartCount >= this.maxRestarts) {
      console.log(chalk.red(`❌ Límite de reinicios alcanzado (${this.maxRestarts})`))
      return false
    }

    return true
  }

  async performRestart(reason = "Error crítico") {
    if (!this.shouldRestart()) return false

    this.restartCount++
    this.lastRestart = Date.now()

    console.log(chalk.yellow(`🔄 Reiniciando bot (${this.restartCount}/${this.maxRestarts}) - Razón: ${reason}`))

    try {
      await this.saveDataBeforeRestart()
      await this.restartConnection()
      console.log(chalk.green("✅ Reinicio exitoso"))
      return true
    } catch (error) {
      console.log(chalk.red("❌ Error durante el reinicio:", error.message))
      return false
    }
  }

  async saveDataBeforeRestart() {
    try {
      if (global.db && global.db.data) {
        await global.db.write()
        console.log(chalk.blue("💾 Datos guardados antes del reinicio"))
      }
    } catch (error) {
      console.log(chalk.yellow("⚠️ Error guardando datos:", error.message))
    }
  }

  async restartConnection() {
    try {
      if (global.conn && global.conn.ws) {
        global.conn.ws.close()
      }

      if (global.conn && global.conn.ev) {
        global.conn.ev.removeAllListeners()
      }

      await initializeBot(true)
      
    } catch (error) {
      throw new Error(`Error reiniciando conexión: ${error.message}`)
    }
  }

  resetRestartCount() {
    this.restartCount = 0
    console.log(chalk.green("🔄 Contador de reinicios reseteado"))
  }
}

class ConnectionManager {
  constructor() {
    this.disconnectHistory = []
    this.reconnectAttempts = 0
    this.error428Count = 0
    this.lastSuccessfulConnection = null
    this.connectionStartTime = Date.now()
  }

  addDisconnect(reason, timestamp = Date.now()) {
    this.disconnectHistory.push({ reason, timestamp })
    
    if (this.disconnectHistory.length > 100) {
      this.disconnectHistory = this.disconnectHistory.slice(-50)
    }

    if (reason === 428) {
      this.error428Count++
    }
  }

  getDisconnectReason(statusCode) {
    const reasons = {
      [DisconnectReason.badSession]: 'Sesión inválida',
      [DisconnectReason.connectionClosed]: 'Conexión cerrada',
      [DisconnectReason.connectionLost]: 'Conexión perdida',
      [DisconnectReason.connectionReplaced]: 'Conexión reemplazada',
      [DisconnectReason.loggedOut]: 'Sesión cerrada',
      [DisconnectReason.restartRequired]: 'Reinicio requerido',
      [DisconnectReason.timedOut]: 'Tiempo agotado',
      [DisconnectReason.multideviceMismatch]: 'Error multidispositivo',
      428: 'Demasiadas conexiones'
    }
    return reasons[statusCode] || `Código desconocido: ${statusCode}`
  }

  getConnectionStats() {
    const now = Date.now()
    const last24h = this.disconnectHistory.filter(
      d => now - d.timestamp < 24 * 60 * 60 * 1000
    ).length

    return {
      totalDisconnects: this.disconnectHistory.length,
      last24h,
      error428Count: this.error428Count,
      reconnectAttempts: this.reconnectAttempts,
      uptime: now - this.connectionStartTime
    }
  }

  async handleReconnection(lastDisconnect, shouldReconnect) {
    if (!shouldReconnect) {
      console.log(chalk.red("❌ No se debe reconectar"))
      return false
    }

    const statusCode = lastDisconnect?.error?.output?.statusCode
    this.addDisconnect(statusCode)

    if (statusCode === 428) {
      const waitTime = Math.min(30000 + (this.error428Count * 5000), 120000)
      console.log(chalk.yellow(`⏳ Esperando ${waitTime/1000}s antes de reconectar (error 428)`))
      await new Promise(resolve => setTimeout(resolve, waitTime))
    }

    this.reconnectAttempts++
    console.log(chalk.blue(`🔄 Intento de reconexión #${this.reconnectAttempts}`))
    
    return true
  }

  onSuccessfulConnection() {
    this.lastSuccessfulConnection = Date.now()
    console.log(chalk.green("✅ Conexión exitosa registrada"))
  }
}

const restartManager = new BotRestartManager()
const connectionManager = new ConnectionManager()

protoType()
serialize()

global.__filename = function filename(pathURL = import.meta.url, rmPrefix = platform !== "win32") {
  return rmPrefix ? (/file:\/\/\//.test(pathURL) ? fileURLToPath(pathURL) : pathURL) : pathToFileURL(pathURL).toString()
}

global.__dirname = function dirname(pathURL) {
  return path.dirname(global.__filename(pathURL, true))
}

global.__require = function require(dir = import.meta.url) {
  return createRequire(dir)
}

global.API = (name, path = "/", query = {}, apikeyqueryname) =>
  (name in global.APIs ? global.APIs[name] : name) +
  path +
  (query || apikeyqueryname
    ? "?" +
      new URLSearchParams(
        Object.entries({
          ...query,
          ...(apikeyqueryname
            ? { [apikeyqueryname]: global.APIKeys[name in global.APIs ? global.APIs[name] : name] }
            : {}),
        }),
      )
    : "")

global.timestamp = {
  start: new Date(),
}

const __dirname = global.__dirname(import.meta.url)

global.opts = new Object(yargs(process.argv.slice(2)).exitProcess(false).parse())
global.prefix = new RegExp(
  "^[" + (global.opts["prefix"] || "‎z/i!#$%+£¢€¥^°=¶∆×÷π√✓©®:;?&.,\\-").replace(/[|\\{}()[\]^$+*?.\-^]/g, "\\$&") + "]",
)

async function initializeDatabase() {
  try {
    global.db = new Low(
      /https?:\/\//.test(global.opts["db"] || "")
        ? new cloudDBAdapter(global.opts["db"])
        : /mongodb(\+srv)?:\/\//i.test(global.opts["db"])
          ? global.opts["mongodbv2"]
            ? new mongoDBV2(global.opts["db"])
            : new mongoDB(global.opts["db"])
          : new JSONFile(`${global.opts._[0] ? global.opts._[0] + "_" : ""}database.json`),
    )

    global.DATABASE = global.db
    await global.loadDatabase()
    console.log(chalk.green("✅ Base de datos inicializada"))
  } catch (error) {
    console.log(chalk.red("❌ Error inicializando base de datos:", error.message))
    throw error
  }
}

function isValidPhoneNumber(phoneNumber) {
  const cleanNumber = phoneNumber.replace(/[^0-9]/g, "")
  const countryCodes = [
    "1", "7", "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49",
    "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86",
    "90", "91", "92", "93", "94", "95", "98", "212", "213", "216", "218", "220", "221", "222", "223", "224", "225",
    "226", "227", "228", "229", "230", "231", "232", "233", "234", "235", "236", "237", "238", "239", "240", "241",
    "242", "243", "244", "245", "246", "247", "248", "249", "250", "251", "252", "253", "254", "255", "256", "257",
    "258", "260", "261", "262", "263", "264", "265", "266", "267", "268", "269", "290", "291", "297", "298", "299",
    "350", "351", "352", "353", "354", "355", "356", "357", "358", "359", "370", "371", "372", "373", "374", "375",
    "376", "377", "378", "380", "381", "382", "383", "385", "386", "387", "389", "420", "421", "423", "500", "501",
    "502", "503", "504", "505", "506", "507", "508", "509", "590", "591", "592", "593", "594", "595", "596", "597",
    "598", "599", "670", "672", "673", "674", "675", "676", "677", "678", "679", "680", "681", "682", "683", "684",
    "685", "686", "687", "688", "689", "690", "691", "692", "850", "852", "853", "855", "856", "880", "886", "960",
    "961", "962", "963", "964", "965", "966", "967", "968", "970", "971", "972", "973", "974", "975", "976", "977",
    "978", "992", "993", "994", "995", "996", "998",
  ]

  return (
    countryCodes.some((code) => cleanNumber.startsWith(code)) && 
    cleanNumber.length >= 10 && 
    cleanNumber.length <= 15
  )
}

global.loadDatabase = async function loadDatabase() {
  if (global.db.READ)
    return new Promise((resolve) =>
      setInterval(async function () {
        if (!global.db.READ) {
          clearInterval(this)
          resolve(global.db.data == null ? global.loadDatabase() : global.db.data)
        }
      }, 1 * 1000),
    )
  if (global.db.data !== null) return
  global.db.READ = true
  
  try {
    await global.db.read()
  } catch (error) {
    console.log(chalk.yellow("⚠️ Error leyendo base de datos:", error.message))
  }
  
  global.db.READ = null
  global.db.data = {
    users: {},
    chats: {},
    stats: {},
    msgs: {},
    sticker: {},
    settings: {},
    ...(global.db.data || {}),
  }
  global.db.chain = chain(global.db.data)
}

async function initializeReloadHandler() {
  const pluginFolder = global.__dirname(join(__dirname, "./plugins/index"))
  let isInit = true
  let handler = null
  
  try {
    handler = await import("./handler.js")
  } catch (error) {
    console.log(chalk.yellow("⚠️ Handler no encontrado, creando función vacía"))
    handler = { handler: null, participantsUpdate: null, groupsUpdate: null, deleteUpdate: null }
  }

  global.reloadHandler = async (restatConn) => {
    try {
      const Handler = await import(`./handler.js?update=${Date.now()}`).catch(() => null)
      if (Handler && Object.keys(Handler).length) handler = Handler
    } catch (e) {
      console.error(chalk.yellow("⚠️ Error recargando handler:", e.message))
    }
    
    if (restatConn && global.conn) {
      const oldChats = global.conn.chats
      try {
        global.conn.ws.close()
      } catch {}
      global.conn.ev.removeAllListeners()
      
      const { state, saveCreds } = await useMultiFileAuthState("sessions")
      const msgRetryCounterCache = new NodeCache({ stdTTL: 0, checkperiod: 0 })
      const userDevicesCache = new NodeCache({ stdTTL: 0, checkperiod: 0 })
      const { version } = await fetchLatestBaileysVersion()
      
      const connectionOptions = {
        version,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu("Chrome"),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        msgRetryCounterCache,
        userDevicesCache,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        emitOwnEvents: true,
        fireInitQueries: true,
        getMessage: async (key) => {
          try {
            const jid = jidNormalizedUser(key.remoteJid)
            const msg = await store.loadMessage(jid, key.id)
            return msg?.message || ""
          } catch (error) {
            return ""
          }
        },
        cachedGroupMetadata: (jid) => global.conn?.chats?.[jid] ?? {},
      }
      
      global.conn = makeWASocket(connectionOptions, { chats: oldChats })
      isInit = true
    }
    
    if (!isInit && global.conn) {
      global.conn.ev.off("messages.upsert", global.conn.handler)
      global.conn.ev.off("group-participants.update", global.conn.participantsUpdate)
      global.conn.ev.off("groups.update", global.conn.groupsUpdate)
      global.conn.ev.off("message.delete", global.conn.onDelete)
      global.conn.ev.off("connection.update", global.conn.connectionUpdate)
      global.conn.ev.off("creds.update", global.conn.credsUpdate)
    }

    if (global.conn) {
      global.conn.welcome = "Hola, @user\nBienvenido a @group"
      global.conn.bye = "Adiós @user"
      global.conn.spromote = "@user fue promovido a admin"
      global.conn.sdemote = "@user fue degradado"
      global.conn.sDesc = "La descripción ha sido cambiada a \n@desc"
      global.conn.sSubject = "El nombre del grupo ha sido cambiado a \n@group"
      global.conn.sIcon = "El icono del grupo ha sido cambiado"
      global.conn.sRevoke = "El enlace del grupo ha sido cambiado a \n@revoke"

      if (handler.handler) global.conn.handler = handler.handler.bind(global.conn)
      if (handler.participantsUpdate) global.conn.participantsUpdate = handler.participantsUpdate.bind(global.conn)
      if (handler.groupsUpdate) global.conn.groupsUpdate = handler.groupsUpdate.bind(global.conn)
      if (handler.deleteUpdate) global.conn.onDelete = handler.deleteUpdate.bind(global.conn)

      if (global.conn.handler) global.conn.ev.on("messages.upsert", global.conn.handler)
      if (global.conn.participantsUpdate) global.conn.ev.on("group-participants.update", global.conn.participantsUpdate)
      if (global.conn.groupsUpdate) global.conn.ev.on("groups.update", global.conn.groupsUpdate)
      if (global.conn.onDelete) global.conn.ev.on("message.delete", global.conn.onDelete)
    }

    isInit = false
    return true
  }
}

async function initializeBot(isRestart = false) {
  try {
    if (!isRestart) {
      await initializeDatabase()
      await initializeReloadHandler()
    }

    const authFolder = "sessions"
    const { state, saveCreds } = await useMultiFileAuthState(authFolder)

    const msgRetryCounterCache = new NodeCache({ stdTTL: 0, checkperiod: 0 })
    const userDevicesCache = new NodeCache({ stdTTL: 0, checkperiod: 0 })

    const { version } = await fetchLatestBaileysVersion()
    console.log(chalk.cyan(`🚀 Usando Baileys v${version.join(".")}`))

    const connectionOptions = {
      version,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: Browsers.ubuntu("Chrome"),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
      },
      msgRetryCounterCache,
      userDevicesCache,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      emitOwnEvents: true,
      fireInitQueries: true,
      getMessage: async (key) => {
        try {
          const jid = jidNormalizedUser(key.remoteJid)
          const msg = await store.loadMessage(jid, key.id)
          return msg?.message || ""
        } catch (error) {
          console.log(chalk.yellow("⚠️ Error obteniendo mensaje:", error.message))
          return ""
        }
      },
      cachedGroupMetadata: (jid) => global.conn?.chats?.[jid] ?? {},
    }

    await setupConnectionMethod(connectionOptions)

    console.info = () => {}
    global.conn = makeWASocket(connectionOptions)
    global.conn.isInit = false

    await setupEventHandlers(saveCreds)

    if (!isRestart) {
      await initializePlugins()
      await setupIntervals()
      await setupServer()
      await runQuickTest()
    }

    console.log(chalk.green(isRestart ? "🔄 Bot reiniciado exitosamente" : "🚀 Bot iniciado exitosamente"))

  } catch (error) {
    console.log(chalk.red("❌ Error inicializando bot:", error.message))
    
    if (restartManager.shouldRestart(error)) {
      setTimeout(() => restartManager.performRestart("Error de inicialización"), 3000)
    } else {
      throw error
    }
  }
}

async function setupConnectionMethod(connectionOptions) {
  const methodCodeQR = process.argv.includes("qr")
  const methodCode = process.argv.includes("code")
  const phoneNumber = global.botNumber?.[0]

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const question = (texto) => new Promise((resolver) => rl.question(texto, resolver))

  let connectionMethod
  if (methodCodeQR) {
    connectionMethod = "qr"
  } else if (methodCode || phoneNumber) {
    connectionMethod = "code"
  } else if (!fs.existsSync("sessions/creds.json")) {
    do {
      connectionMethod = await question(
        chalk.cyan("\n🔗 Selecciona el método de conexión:\n") +
          chalk.white("1️⃣  Código QR\n") +
          chalk.white("2️⃣  Código de 8 dígitos\n") +
          chalk.yellow("Ingresa tu opción (1 o 2): "),
      )
      if (!/^[1-2]$/.test(connectionMethod)) {
        console.log(chalk.red("\n❌ Por favor ingresa solo 1 o 2\n"))
      }
    } while (connectionMethod !== "1" && connectionMethod !== "2")

    connectionMethod = connectionMethod === "1" ? "qr" : "code"
  }

  if (connectionMethod === "qr") {
    connectionOptions.printQRInTerminal = true
  }

  if (connectionMethod === "code" && !global.conn?.authState?.creds?.registered) {
    await handleCodeConnection(phoneNumber, question, rl)
  }
}

async function handleCodeConnection(phoneNumber, question, rl) {
  let addNumber

  if (phoneNumber) {
    addNumber = phoneNumber.replace(/[^0-9]/g, "")
    if (!isValidPhoneNumber(addNumber)) {
      console.log(chalk.red("\n❌ Número inválido. Verifica el código de país."))
      process.exit(0)
    }
  } else {
    while (true) {
      addNumber = await question(
        chalk.cyan("\n📱 Ingresa tu número de teléfono:\n") +
          chalk.gray("Ejemplo: 5491168123456\n") +
          chalk.yellow("Número: "),
      )

      addNumber = addNumber.replace(/[^0-9]/g, "")

      if (addNumber.match(/^\d+$/) && isValidPhoneNumber(addNumber)) {
        break
      } else {
        console.log(chalk.red("\n❌ Número inválido. Asegúrate de incluir el código de país."))
      }
    }
    rl.close()
  }

  setTimeout(async () => {
    try {
      const code = await global.conn.requestPairingCode(addNumber)
      const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code
      console.log(chalk.green("\n✅ Código de emparejamiento generado:"))
      console.log(chalk.bgBlue(chalk.white(`\n   ${formattedCode}   \n`)))
      console.log(chalk.yellow("📲 Ingresa este código en WhatsApp"))
    } catch (error) {
      console.log(chalk.red("\n❌ Error al generar código:", error.message))
      if (restartManager.shouldRestart(error)) {
        restartManager.performRestart("Error generando código")
      }
    }
  }, 3000)
}

async function setupEventHandlers(saveCreds) {
  async function connectionUpdate(update) {
    try {
      const { connection, lastDisconnect, isNewLogin, qr } = update

      if (qr) {
        console.log(chalk.yellow("\n📱 Escanea el código QR con WhatsApp"))
      }

      if (connection === "close") {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
        const statusCode = lastDisconnect?.error?.output?.statusCode

        console.log(chalk.red(`\n❌ Conexión cerrada. Código: ${statusCode}`))
        console.log(chalk.yellow(`📊 Razón: ${connectionManager.getDisconnectReason(statusCode)}`))

        const stats = connectionManager.getConnectionStats()
        console.log(
          chalk.cyan(`📈 Estadísticas - Desconexiones 24h: ${stats.last24h}, Errores 428: ${stats.error428Count}`),
        )

        const reconnectResult = await connectionManager.handleReconnection(lastDisconnect, shouldReconnect)

        if (!reconnectResult && shouldReconnect) {
          console.log(chalk.yellow("🔄 Intentando reinicio del sistema..."))
          await restartManager.performRestart("Fallo de reconexión")
        }
      } else if (connection === "open") {
        connectionManager.onSuccessfulConnection()
        global.conn.isInit = true

        console.log(chalk.green("✅ ¡Bot conectado exitosamente!"))
        console.log(chalk.cyan(`📱 Número: ${global.conn.user?.id?.split(":")[0]}`))
        console.log(chalk.cyan(`👤 Nombre: ${global.conn.user?.name || "Sin nombre"}`))

        restartManager.resetRestartCount()

        const stats = connectionManager.getConnectionStats()
        if (stats.totalDisconnects > 0) {
          console.log(chalk.blue(`📊 Total de reconexiones exitosas: ${stats.reconnectAttempts}`))
        }
      }

      if (isNewLogin) {
        global.conn.isInit = true
        console.log(chalk.green("🆕 Nueva sesión iniciada"))
      }

      if (global.db.data == null) await global.loadDatabase()
    } catch (error) {
      console.log(chalk.red("❌ Error en connectionUpdate:", error.message))
      if (restartManager.shouldRestart(error)) {
        await restartManager.performRestart("Error en connectionUpdate")
      }
    }
  }

  if (typeof global.reloadHandler === 'function') {
    await global.reloadHandler()
  }
  
  global.conn.connectionUpdate = connectionUpdate.bind(global.conn)
  global.conn.credsUpdate = saveCreds.bind(global.conn, true)

  global.conn.ev.on("connection.update", global.conn.connectionUpdate)
  global.conn.ev.on("creds.update", global.conn.credsUpdate)
}

async function initializePlugins() {
  const pluginFolder = global.__dirname(join(__dirname, "./plugins/index"))
  const pluginFilter = (filename) => /\.js$/.test(filename)
  global.plugins = {}

  async function filesInit() {
    for (const filename of readdirSync(pluginFolder).filter(pluginFilter)) {
      try {
        const file = global.__filename(join(pluginFolder, filename))
        const module = await import(file)
        global.plugins[filename] = module.default || module
      } catch (e) {
        console.error(chalk.red(`Error cargando plugin ${filename}:`), e)
        delete global.plugins[filename]
      }
    }
  }

  await filesInit()
  console.log(chalk.green(`✅ Plugins cargados: ${Object.keys(global.plugins).length}`))

  global.reload = async (_ev, filename) => {
    if (pluginFilter(filename)) {
      const dir = global.__filename(join(pluginFolder, filename), true)
      if (filename in global.plugins) {
        if (existsSync(dir)) console.log(chalk.blue(`🔄 Plugin actualizado: ${filename}`))
        else {
          console.log(chalk.yellow(`🗑️ Plugin eliminado: ${filename}`))
          return delete global.plugins[filename]
        }
      } else console.log(chalk.green(`✨ Nuevo plugin: ${filename}`))

      const err = syntaxerror(fs.readFileSync(dir), filename, {
        sourceType: "module",
        allowAwaitOutsideFunction: true,
      })
      if (err) console.error(chalk.red(`Error de sintaxis en ${filename}:`), format(err))
      else
        try {
          const module = await import(`${global.__filename(dir)}?update=${Date.now()}`)
          global.plugins[filename] = module.default || module
        } catch (e) {
          console.error(chalk.red(`Error cargando plugin ${filename}:`), format(e))
        } finally {
          global.plugins = Object.fromEntries(Object.entries(global.plugins).sort(([a], [b]) => a.localeCompare(b)))
        }
    }
  }

  Object.freeze(global.reload)
  watchFile(pluginFolder, global.reload)
}

async function clearTmp() {
  try {
    const tmp = [tmpdir(), join(__dirname, "./tmp")]
    const filename = []
    tmp.forEach((dirname) => {
      if (existsSync(dirname)) {
        readdirSync(dirname).forEach((file) => filename.push(join(dirname, file)))
      }
    })

    return filename.map((file) => {
      try {
        const stats = statSync(file)
        if (stats.isFile() && Date.now() - stats.mtimeMs >= 1000 * 60 * 3) {
          unlinkSync(file)
          return true
        }
      } catch (e) {
        return false
      }
      return false
    })
  } catch (error) {
    console.log(chalk.yellow("⚠️ Error limpiando archivos temporales:", error.message))
    return []
  }
}

process.on("uncaughtException", async (error) => {
  console.log(chalk.red("❌ Error no capturado:", error.message))
  console.log(chalk.yellow("🔄 Intentando mantener el bot funcionando..."))
  
  try {
    if (global.db && global.db.data) {
      await global.db.write()
    }
  } catch (e) {
    console.log(chalk.yellow("⚠️ Error guardando datos:", e.message))
  }

  if (restartManager.criticalErrors.has(error.code) || error.message.includes('ECONNRESET')) {
    await restartManager.performRestart(`Error crítico: ${error.message}`)
  }
})

process.on("unhandledRejection", async (reason, promise) => {
  console.log(chalk.red("❌ Promesa rechazada:", reason))
  console.log(chalk.yellow("🔄 El bot continuará funcionando..."))
  
  if (reason && typeof reason === 'object' && restartManager.criticalErrors.has(reason.code)) {
    await restartManager.performRestart(`Promesa rechazada: ${reason.message || reason}`)
  }
})

async function setupIntervals() {
  if (!global.opts["test"]) {
    setInterval(async () => {
      try {
        if (global.db && global.db.data) {
          await global.db.write()
        }
        if (global.opts["autocleartmp"]) {
          await clearTmp()
        }

        const now = new Date()
        if (now.getMinutes() % 30 === 0 && now.getSeconds() < 5) {
          const stats = connectionManager?.getConnectionStats?.()
          if (stats && stats.totalDisconnects > 0) {
            console.log(chalk.blue(`📊 Estadísticas de conexión - Desconexiones 24h: ${stats.last24h}`))
          }
        }
      } catch (error) {
        console.log(chalk.yellow("⚠️ Error en intervalo:", error.message))
      }
    }, 60 * 1000)
  }
}

async function setupServer() {
  if (global.opts["server"]) {
    try {
      const server = await import("./server.js")
      server.default(global.conn, PORT)
    } catch (e) {
      console.log(chalk.yellow("⚠️ Servidor no disponible"))
    }
  }
}

async function runQuickTest() {
  async function _quickTest() {
    try {
      const test = await Promise.all(
        [spawn("ffmpeg"), spawn("ffprobe"), spawn("convert"), spawn("magick"), spawn("gm")].map((p) => {
          return Promise.race([
            new Promise((resolve) => {
              p.on("close", (code) => {
                resolve(code !== 127)
              })
            }),
            new Promise((resolve) => {
              p.on("error", (_) => resolve(false))
            }),
          ])
        }),
      )

      const [ffmpeg, ffprobe, convert, magick, gm] = test
      const s = (global.support = {
        ffmpeg,
        ffprobe,
        convert,
        magick,
        gm,
      })

      Object.freeze(global.support)

      if (!s.ffmpeg) console.log(chalk.yellow("⚠️ FFmpeg no instalado"))
      if (!s.convert && !s.magick && !s.gm) console.log(chalk.yellow("⚠️ ImageMagick no instalado"))
    } catch (error) {
      console.log(chalk.yellow("⚠️ Error en prueba rápida:", error.message))
    }
  }

  await _quickTest()
  console.log(chalk.green("✅ Prueba rápida completada"))
}

console.log(chalk.cyan("🚀 Iniciando WhatsApp Bot con sistema de reinicio automático mejorado..."))

try {
  await initializeBot()
} catch (error) {
  console.log(chalk.red("❌ Error fatal iniciando bot:", error.message))
  process.exit(1)
}

process.stdin.resume()
