import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import Redis from 'ioredis'
import { montarPanel } from './panel.js'

const PORT = Number(process.env.PORT || 8080)
const ID = process.env.ORQ_ID || 'orq-1'
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380'
const JUEGO_WS_PUBLICO = process.env.JUEGO_WS_PUBLICO || 'ws://localhost:8090'

const NIVELES = ['basico', 'medio', 'avanzado']
const nivelValido = (n) => (NIVELES.includes(n) ? n : 'basico')

const redis = new Redis(REDIS_URL)
const sub = new Redis(REDIS_URL)
const clientes = new Map()

const leer = async (id) => {
  const raw = await redis.hget('orq:usuarios', id)
  return raw ? JSON.parse(raw) : null
}

const guardar = (id, u) => redis.hset('orq:usuarios', id, JSON.stringify(u))

const marcar = async (id, buscando) => {
  const u = await leer(id)
  if (!u) return
  u.buscando = buscando
  u.desde = buscando ? Date.now() : null
  await guardar(id, u)
  clientes.get(id)?.enviar({ t: buscando ? 'buscando' : 'libre', desde: u.desde })
}

const servidor = http.createServer()
const wss = new WebSocketServer({ server: servidor })

wss.on('connection', (ws) => {
  let userId = null

  ws.on('message', async (data) => {
    let msg
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }

    if (msg.t === 'hola' && !userId) {
      userId = randomUUID().slice(0, 8)
      await guardar(userId, {
        nombre: String(msg.nombre || 'anónimo').slice(0, 20),
        nivel: nivelValido(msg.nivel),
        buscando: false,
        desde: null,
        orquestador: ID,
        esBot: false
      })
      clientes.set(userId, { enviar: (m) => ws.send(JSON.stringify(m)) })
      ws.send(JSON.stringify({ t: 'bienvenido', userId, orquestador: ID }))
      return
    }

    if (!userId) return

    if (msg.t === 'buscar') await marcar(userId, true)

    if (msg.t === 'cancelar') await marcar(userId, false)

    if (msg.t === 'nivel') {
      const u = await leer(userId)
      if (!u) return
      u.nivel = nivelValido(msg.nivel)
      await guardar(userId, u)
    }
  })

  ws.on('close', async () => {
    if (!userId) return
    clientes.delete(userId)
    await redis.hdel('orq:usuarios', userId)
  })
})

sub.subscribe('orq:matches')
sub.on('message', (_canal, raw) => {
  const m = JSON.parse(raw)
  for (const j of m.jugadores) {
    const cli = clientes.get(j.userId)
    if (!cli) continue
    const rival = m.jugadores.find((x) => x.userId !== j.userId)
    cli.enviar({
      t: 'emparejado',
      salaId: m.salaId,
      ticket: j.ticket,
      url: JUEGO_WS_PUBLICO,
      rival: rival ? rival.nombre : null,
      rivalNivel: rival ? rival.nivel : null
    })
  }
})

montarPanel({ ID, servidor, redis, clientes, guardar, marcar, nivelValido })

servidor.listen(PORT, () => console.log(`${ID} escuchando en ${PORT}`))
