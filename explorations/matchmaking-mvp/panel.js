import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const AQUI = path.dirname(fileURLToPath(import.meta.url))
const JUEGO_WS_INTERNO = process.env.JUEGO_WS_INTERNO || 'ws://localhost:8090'
const PREFIJO = { basico: 'bas', medio: 'med', avanzado: 'avz' }

const cuerpo = (req) =>
  new Promise((ok) => {
    let d = ''
    req.on('data', (c) => (d += c))
    req.on('end', () => {
      try {
        ok(JSON.parse(d || '{}'))
      } catch {
        ok({})
      }
    })
  })

const archivo = (res, nombre, tipo) => {
  fs.readFile(path.join(AQUI, 'public', nombre), (err, buf) => {
    if (err) {
      res.writeHead(404).end('no está')
      return
    }
    res.writeHead(200, { 'content-type': tipo }).end(buf)
  })
}

const json = (res, obj) =>
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(obj))

export function montarPanel({ ID, servidor, redis, clientes, guardar, marcar, nivelValido }) {
  const manejarBot = (m) => {
    if (m.t !== 'emparejado') return
    const ws = new WebSocket(`${JUEGO_WS_INTERNO}/?ticket=${m.ticket}`)
    ws.on('error', () => {})
  }

  const crearBot = async (buscando, nivel) => {
    const n = nivelValido(nivel)
    const userId = PREFIJO[n] + '-' + randomUUID().slice(0, 4)
    await guardar(userId, {
      nombre: userId,
      nivel: n,
      buscando,
      desde: buscando ? Date.now() : null,
      orquestador: ID,
      esBot: true
    })
    clientes.set(userId, { enviar: manejarBot })
    return userId
  }

  const borrarBots = async () => {
    const todos = await redis.hgetall('orq:usuarios')
    for (const [id, raw] of Object.entries(todos)) {
      if (!JSON.parse(raw).esBot) continue
      await redis.hdel('orq:usuarios', id)
      clientes.delete(id)
    }
  }

  const estado = async () => {
    const [usuariosRaw, salasRaw] = await Promise.all([
      redis.hgetall('orq:usuarios'),
      redis.hgetall('orq:salas')
    ])
    const salas = Object.entries(salasRaw).map(([salaId, raw]) => ({ salaId, ...JSON.parse(raw) }))
    const dondeJuega = new Map()
    for (const s of salas) for (const j of s.jugadores) dondeJuega.set(j.userId, s.salaId)
    const usuarios = Object.entries(usuariosRaw).map(([userId, raw]) => ({
      userId,
      ...JSON.parse(raw),
      sala: dondeJuega.get(userId) || null,
      conectado: clientes.has(userId)
    }))
    return { orquestador: ID, ahora: Date.now(), usuarios, salas }
  }

  servidor.on('request', async (req, res) => {
    const url = new URL(req.url, 'http://x')

    if (url.pathname === '/' || url.pathname === '/index.html')
      return archivo(res, 'index.html', 'text/html; charset=utf-8')

    if (url.pathname === '/admin' || url.pathname === '/admin.html')
      return archivo(res, 'admin.html', 'text/html; charset=utf-8')

    if (url.pathname === '/admin/estado') return json(res, await estado())

    if (url.pathname === '/admin/bots' && req.method === 'POST') {
      const { cantidad = 1, buscando = true, nivel = 'basico' } = await cuerpo(req)
      const creados = []
      for (let i = 0; i < Number(cantidad); i++) creados.push(await crearBot(Boolean(buscando), nivel))
      return json(res, { creados })
    }

    if (url.pathname === '/admin/bots' && req.method === 'DELETE') {
      await borrarBots()
      return json(res, { ok: true })
    }

    if (url.pathname === '/admin/buscar' && req.method === 'POST') {
      const { userId, buscando } = await cuerpo(req)
      await marcar(userId, Boolean(buscando))
      return json(res, { ok: true })
    }

    res.writeHead(404).end('no está')
  })

  setInterval(async () => {
    const todos = await redis.hgetall('orq:usuarios')
    const buscando = Object.values(todos)
      .map((raw) => JSON.parse(raw))
      .filter((u) => u.buscando)
      .map((u) => ({ nombre: u.nombre, nivel: u.nivel, desde: u.desde, esBot: u.esBot }))
    for (const c of clientes.values()) c.enviar({ t: 'pool', buscando })
  }, 1000)
}
