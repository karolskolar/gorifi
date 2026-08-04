<script setup>
// Guest share link for one cycle — "Zdieľať objednávku s kolegami".
// The host owns exactly one link per cycle (`guest_order_links`); colleagues
// order through /g/:token without an account and the host hands the goods over.
// Shared by FriendOrder.vue (inside a cycle) and FriendPortal.vue (cycle list),
// so both entry points drive the same create / regenerate / deactivate logic.
import { ref, computed, watch } from 'vue'
import api from '../api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

const props = defineProps({
  open: { type: Boolean, default: false },
  cycleId: { type: [String, Number], default: null },
  cycleName: { type: String, default: '' }
})

const emit = defineEmits(['update:open'])

const loading = ref(false)
const saving = ref(false)
const error = ref('')
const link = ref(null) // { id, token, active, ... } or null when not shared yet
const copied = ref(false)
const confirmRegenerate = ref(false)

// navigator.share exists on mobile browsers only — the copy button is the
// fallback everywhere else.
const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

const guestUrl = computed(() =>
  link.value ? `${window.location.origin}/g/${link.value.token}` : ''
)

// One dialog instance is reused for every cycle (FriendPortal renders a share
// button per cycle card), so responses MUST be sequence-guarded: a slow GET for a
// cycle the host already closed would otherwise land on top of the cycle now on
// screen. That is not cosmetic — the host would copy the wrong /g/:token (their
// colleagues then order into the wrong cycle), and toggleActive()/saveLink()
// would act on the stale link.value.id, hitting a different cycle's row.
// Every request bumps loadSeq and drops its own result if it is no longer the
// newest one.
let loadSeq = 0

// Load on every open so a link created from the other entry point shows up, and
// clear on close so a reopen can never flash the previous cycle's link.
watch(() => props.open, async (isOpen) => {
  const seq = ++loadSeq
  copied.value = false
  error.value = ''
  confirmRegenerate.value = false
  link.value = null
  saving.value = false
  loading.value = false
  if (!isOpen || !props.cycleId) return

  loading.value = true
  try {
    const data = await api.getGuestLink(props.cycleId)
    if (seq !== loadSeq) return
    link.value = data.link
  } catch (e) {
    if (seq !== loadSeq) return
    error.value = e.message
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}, { immediate: true })

// Create the link, or issue a fresh token for an existing one. The backend keeps
// the same link row, so sub-orders colleagues already placed are preserved.
async function saveLink() {
  const seq = ++loadSeq // invalidates any in-flight GET so it cannot clobber this
  error.value = ''
  saving.value = true
  try {
    const data = await api.createGuestLink(props.cycleId)
    if (seq !== loadSeq) return
    link.value = data.link
    copied.value = false
    confirmRegenerate.value = false
  } catch (e) {
    if (seq !== loadSeq) return
    error.value = e.message
  } finally {
    if (seq === loadSeq) saving.value = false
  }
}

async function toggleActive() {
  if (!link.value) return
  const seq = ++loadSeq
  const targetId = link.value.id
  const nextActive = !link.value.active
  error.value = ''
  saving.value = true
  try {
    const data = await api.setGuestLinkActive(targetId, nextActive)
    if (seq !== loadSeq) return
    link.value = data.link
  } catch (e) {
    if (seq !== loadSeq) return
    error.value = e.message
  } finally {
    if (seq === loadSeq) saving.value = false
  }
}

async function copyLink() {
  const url = guestUrl.value
  if (!url) return
  try {
    await navigator.clipboard.writeText(url)
  } catch (e) {
    // Fallback for browsers without the async clipboard API
    const input = document.createElement('input')
    input.value = url
    document.body.appendChild(input)
    input.select()
    document.execCommand('copy')
    document.body.removeChild(input)
  }
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

// Native share sheet on mobile; the button is hidden where navigator.share is
// unavailable, so the copy button is always the fallback.
async function nativeShare() {
  if (!canNativeShare || !guestUrl.value) return
  try {
    await navigator.share({
      title: 'Objednávka Gorifi',
      text: `Pridajte sa k mojej objednávke — ${props.cycleName || 'objednávkový cyklus'}`,
      url: guestUrl.value
    })
  } catch (e) {
    // User dismissed the share sheet — nothing to report
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Zdieľať s kolegami</DialogTitle>
        <DialogDescription>
          <!-- Name the cycle: from the portal several open cycles sit side by
               side, so an unlabelled URL cannot be verified by the host. -->
          <span v-if="cycleName" class="block font-medium text-foreground">{{ cycleName }}</span>
          Kolegovia si objednajú cez váš odkaz — bez registrácie. Zásielku prevezmete vy a odovzdáte im ju.
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-4 py-2">
        <Alert v-if="error" variant="destructive">
          <AlertDescription>{{ error }}</AlertDescription>
        </Alert>

        <div v-if="loading" class="text-center py-4 text-muted-foreground">Načítavam...</div>

        <template v-else>
          <!-- Not shared yet -->
          <div v-if="!link" class="space-y-3">
            <p class="text-sm text-muted-foreground">Odkaz ešte nie je vytvorený.</p>
            <Button class="w-full" :disabled="saving" @click="saveLink()">
              {{ saving ? 'Vytváram...' : 'Vytvoriť odkaz' }}
            </Button>
          </div>

          <!-- Link exists -->
          <div v-else class="space-y-3">
            <Alert v-if="!link.active" class="border-yellow-500 bg-yellow-50 text-yellow-800">
              <AlertDescription>
                Odkaz je deaktivovaný — kolegovia si cez neho nemôžu objednať.
              </AlertDescription>
            </Alert>

            <div class="flex items-center gap-2">
              <Input
                :model-value="guestUrl"
                readonly
                data-testid="guest-link-url"
                class="font-mono text-xs"
              />
              <Button variant="outline" size="sm" class="shrink-0" @click="copyLink">
                {{ copied ? 'Skopírované!' : 'Kopírovať' }}
              </Button>
            </div>

            <!-- Native share sheet (mobile only) -->
            <Button v-if="canNativeShare" class="w-full" @click="nativeShare">
              Zdieľať
            </Button>

            <div class="flex flex-wrap items-center gap-2 pt-1">
              <Button
                variant="ghost"
                size="sm"
                class="text-muted-foreground"
                :disabled="saving"
                @click="toggleActive"
              >
                {{ link.active ? 'Deaktivovať odkaz' : 'Znova aktivovať' }}
              </Button>
              <Button
                v-if="!confirmRegenerate"
                variant="ghost"
                size="sm"
                class="text-muted-foreground"
                @click="confirmRegenerate = true"
              >
                Vygenerovať nový odkaz
              </Button>
              <div v-else class="w-full space-y-2 rounded-md border border-yellow-400 bg-yellow-50 p-3">
                <p class="text-xs text-yellow-800">
                  Starý odkaz prestane fungovať. Objednávky, ktoré vám kolegovia už poslali, zostanú zachované.
                </p>
                <div class="flex gap-2">
                  <Button size="sm" :disabled="saving" @click="saveLink()">
                    {{ saving ? 'Generujem...' : 'Áno, vygenerovať' }}
                  </Button>
                  <Button variant="ghost" size="sm" @click="confirmRegenerate = false">Zrušiť</Button>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="emit('update:open', false)">Zavrieť</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
