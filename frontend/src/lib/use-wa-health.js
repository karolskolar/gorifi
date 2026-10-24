// 21 §UC-WA-012 / §UC-WA-009 — THE ONE HOME of the admin's `gorifi-wa` health reading.
//
// Two pages poll the API's health PROXY (`GET /api/admin/whatsapp/health`, always 200,
// `{ reachable:false, opt_in, paused }` when the process is down): the settings page
// (WA-T7, `AdminWhatsAppSettings.vue`) and the composer (WA-T8, `AdminWhatsApp.vue`,
// whose offline/pause banner and wa.me „released row" rule read the same answer). WA-T7
// wrote the loader inline; WA-T8 moved it HERE rather than fork it.
//
// ⚠ `seq` is the `loadSeq` guard (CLAUDE.md §Frontend): only the LATEST request's answer
// is applied. `invalidate()` bumps it and re-reads — a caller that just WROTE something
// the health reflects (the pause toggle) calls it, so a poll issued before the write
// cannot repaint the old state.
// ⚠ The QR in a `state:'qr'` answer is a pairing credential: it lives only in this
// instance's `health` ref, which is dropped on unmount — never stored anywhere else.
// ⚠ Must be called from a component's `setup` (it registers onMounted/onUnmounted).
import { ref, computed, onMounted, onUnmounted } from 'vue'
import api from '../api'

export const WA_HEALTH_POLL_MS = 5000

export function useWaHealth({ pollMs = WA_HEALTH_POLL_MS, onHealth } = {}) {
  const health = ref(null)
  const healthError = ref('')
  let seq = 0
  let timer = null
  let unmounted = false

  async function load() {
    const mine = ++seq
    try {
      const h = await api.getWhatsappHealth()
      if (unmounted || mine !== seq) return
      health.value = h
      healthError.value = ''
      if (typeof onHealth === 'function') onHealth(h)
    } catch (e) {
      if (unmounted || mine !== seq) return
      // The API itself failed: the process state is UNKNOWN — drop the last answer (and
      // with it any QR) rather than keep painting a stale one.
      health.value = null
      healthError.value = e.message || 'Stav sa nepodarilo načítať'
    }
  }

  function invalidate() {
    seq++
    return load()
  }

  const reachable = computed(() => health.value?.reachable === true)
  const connected = computed(() => reachable.value && health.value.state === 'connected')
  // `paused` is the API's own DB fact on BOTH branches of the proxy (WA-T7 decision 1).
  const paused = computed(() => health.value?.paused === true)

  onMounted(() => {
    load()
    if (pollMs > 0) timer = setInterval(load, pollMs)
  })

  onUnmounted(() => {
    unmounted = true
    seq++
    if (timer) clearInterval(timer)
    timer = null
    health.value = null
  })

  return { health, healthError, reachable, connected, paused, load, invalidate }
}
