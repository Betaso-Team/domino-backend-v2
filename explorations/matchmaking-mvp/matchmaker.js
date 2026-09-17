import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380'
const JUEGO_URL = process.env.JUEGO_URL || 'http://localhost:8090'
const CADA = Number(process.env.CADA_MS || 1000)

const NIVELES = ['basico', 'medio', 'avanzado']
const ESPERA_POR_DISTANCIA = [0, 5000, 10000]

const redis = new Redis(REDIS_URL)

function distancia(a, b) {
  return Math.abs(NIVELES.indexOf(a.nivel) - NIVELES.indexOf(b.nivel))
}

function emparejar(candidatos, ahora) {
  const orden = [...candidatos].sort((a, b) => (a.desde || 0) - (b.desde || 0))
  const usados = new Set()
  const parejas = []

  for (const a of orden) {
    if (usados.has(a.userId)) continue
    let mejor = null

    for (const b of orden) {
      if (b.userId === a.userId || usados.has(b.userId)) continue
      const d = distancia(a, b)
      const espera = Math.max(ahora - a.desde, ahora - b.desde)
      if (espera < ESPERA_POR_DISTANCIA[d]) continue
      if (!mejor || d < mejor.d) mejor = { b, d, espera }
    }

    if (!mejor) continue
    usados.add(a.userId)
    usados.add(mejor.b.userId)
    parejas.push({ jugadores: [a, mejor.b], distancia: mejor.d, espera: mejor.espera })
  }

  return parejas
}

const quitarDeLaBusqueda = async (jugador) => {
  const raw = await redis.hget('orq:usuarios', jugador.userId)
  if (!raw) return false
  const u = JSON.parse(raw)
  if (!u.buscando) return false
  u.buscando = false
  u.desde = null
  await redis.hset('orq:usuarios', jugador.userId, JSON.stringify(u))
  return true
}

const segundos = (ms) => (ms / 1000).toFixed(1) + 's'

const vuelta = async () => {
  const ahora = Date.now()
  const todos = await redis.hgetall('orq:usuarios')
  const candidatos = Object.entries(todos)
    .map(([userId, raw]) => ({ userId, ...JSON.parse(raw) }))
    .filter((u) => u.buscando)

  for (const pareja of emparejar(candidatos, ahora)) {
    const [a, b] = pareja.jugadores
    const tomados = []
    for (const j of pareja.jugadores) if (await quitarDeLaBusqueda(j)) tomados.push(j)
    if (tomados.length < 2) continue

    const r = await fetch(`${JUEGO_URL}/salas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jugadores: pareja.jugadores.map((j) => ({ userId: j.userId, nombre: j.nombre, nivel: j.nivel }))
      })
    })
    const { salaId } = await r.json()

    const jugadores = []
    for (const j of pareja.jugadores) {
      const ticket = randomUUID()
      await redis.hset('orq:tickets', ticket, JSON.stringify({ userId: j.userId, salaId }))
      jugadores.push({ userId: j.userId, nombre: j.nombre, nivel: j.nivel, ticket })
    }

    await redis.publish('orq:matches', JSON.stringify({ salaId, jugadores }))

    const exigido = ESPERA_POR_DISTANCIA[pareja.distancia]
    const motivo = pareja.distancia === 0
      ? 'mismo nivel, sin espera'
      : `distancia ${pareja.distancia}, exigía ${segundos(exigido)} y esperó ${segundos(pareja.espera)}`
    console.log(
      `emparejo a ${a.nombre} [${a.nivel} ${segundos(ahora - a.desde)}] ` +
        `con ${b.nombre} [${b.nivel} ${segundos(ahora - b.desde)}] -> ${salaId} (${motivo})`
    )
  }
}

setInterval(() => vuelta().catch((e) => console.log('vuelta falló:', e.message)), CADA)
console.log(`matchmaker mirando la pool cada ${CADA} ms`)
console.log(`espera por distancia de nivel: ${ESPERA_POR_DISTANCIA.map(segundos).join(' / ')}`)
