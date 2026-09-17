import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { WebSocketServer } from 'ws'
import Redis from 'ioredis'

const PORT = Number(process.env.PORT || 8090)
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380'

const redis = new Redis(REDIS_URL)
const salas = new Map()

const publicar = (salaId) => {
  const sala = salas.get(salaId)
  if (!sala) return
  return redis.hset(
    'orq:salas',
    salaId,
    JSON.stringify({
      jugadores: sala.jugadores,
      creada: sala.creada,
      conectados: [...sala.conectados.keys()]
    })
  )
}

const avisar = (salaId) => {
  const sala = salas.get(salaId)
  if (!sala) return
  const msg = JSON.stringify({
    t: 'en-sala',
    salaId,
    jugadores: sala.jugadores,
    conectados: [...sala.conectados.keys()]
  })
  for (const ws of sala.conectados.values()) ws.send(msg)
}

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

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')

  if (url.pathname === '/salas' && req.method === 'POST') {
    const { jugadores } = await cuerpo(req)
    const salaId = 'r-' + randomBytes(2).toString('hex')
    salas.set(salaId, { jugadores, creada: Date.now(), conectados: new Map() })
    await publicar(salaId)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ salaId }))
    return
  }

  res.writeHead(404).end('no está')
})

const wss = new WebSocketServer({ server: servidor })

wss.on('connection', async (ws, req) => {
  const ticket = new URL(req.url, 'http://x').searchParams.get('ticket')
  const raw = ticket ? await redis.hget('orq:tickets', ticket) : null
  if (!raw) return ws.close()
  await redis.hdel('orq:tickets', ticket)

  const { userId, salaId } = JSON.parse(raw)
  const sala = salas.get(salaId)
  if (!sala) return ws.close()

  sala.conectados.set(userId, ws)
  const completa = sala.conectados.size === sala.jugadores.length
  await publicar(salaId)
  avisar(salaId)

  if (completa)
    console.log(`sala ${salaId} lista: ${sala.jugadores.map((j) => j.nombre).join(', ')}`)

  ws.on('close', async () => {
    sala.conectados.delete(userId)
    if (sala.conectados.size === 0) {
      salas.delete(salaId)
      await redis.hdel('orq:salas', salaId)
      return
    }
    await publicar(salaId)
    avisar(salaId)
  })
})

servidor.listen(PORT, () => console.log(`jueguito escuchando en ${PORT}`))
