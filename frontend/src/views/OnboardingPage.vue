<script setup>
import { ref, onMounted, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

const route = useRoute()
const router = useRouter()

const loading = ref(true)
const linkInfo = ref(null)        // { active, note } when link is found
const linkError = ref('')         // 404 / network error message
const inactive = ref(false)       // link exists but is inactive

const form = ref({ name: '', phone: '', email: '', username: '', password: '' })
const fieldErrors = ref({})       // { username: 'taken', ... }
const usernameStatus = ref('')    // '', 'checking', 'available', 'taken', 'invalid'
const submitting = ref(false)
const submitError = ref('')

const token = computed(() => route.params.token)

onMounted(async () => {
  try {
    linkInfo.value = await api.getOnboardingLink(token.value)
    if (!linkInfo.value.active) inactive.value = true
  } catch (e) {
    linkError.value = e.message || 'Odkaz neexistuje'
  } finally {
    loading.value = false
  }
})

let usernameTimer = null
watch(() => form.value.username, (val) => {
  fieldErrors.value.username = ''
  if (!val) { usernameStatus.value = ''; return }
  usernameStatus.value = 'checking'
  clearTimeout(usernameTimer)
  usernameTimer = setTimeout(async () => {
    try {
      const r = await api.checkOnboardingUsername(token.value, val.toLowerCase().trim())
      if (r.available) usernameStatus.value = 'available'
      else if (r.reason) { usernameStatus.value = 'invalid'; fieldErrors.value.username = r.reason }
      else { usernameStatus.value = 'taken'; fieldErrors.value.username = 'Užívateľské meno je už obsadené' }
    } catch (e) {
      usernameStatus.value = ''
    }
  }, 350)
})

async function submit() {
  submitError.value = ''
  fieldErrors.value = {}

  if (!form.value.name.trim()) { fieldErrors.value.name = 'Meno je povinné'; return }
  if (!form.value.phone.trim()) { fieldErrors.value.phone = 'Mobil je povinný'; return }
  if (!form.value.username.trim()) { fieldErrors.value.username = 'Užívateľské meno je povinné'; return }
  if (form.value.password.length < 8) { fieldErrors.value.password = 'Heslo musí mať aspoň 8 znakov'; return }

  submitting.value = true
  try {
    const result = await api.submitOnboarding(token.value, {
      name: form.value.name.trim(),
      phone: form.value.phone.trim(),
      email: form.value.email.trim(),
      username: form.value.username.toLowerCase().trim(),
      password: form.value.password,
    })

    // Persist the session in the same shape FriendPortal expects from modern login.
    localStorage.setItem('gorifi_friend_auth', JSON.stringify({
      friendId: result.friendId,
      friendName: result.friendName,
      token: result.token,
      expiresAt: result.expiresAt,
    }))

    router.push('/')
  } catch (e) {
    if (e.field) fieldErrors.value[e.field] = e.message
    else submitError.value = e.message || 'Nepodarilo sa odoslať formulár'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="min-h-screen bg-background flex items-center justify-center p-4">
    <div class="w-full max-w-md">
      <div v-if="loading" class="text-center text-muted-foreground py-12">Načítavam…</div>

      <Card v-else-if="linkError">
        <CardHeader><CardTitle>Odkaz neexistuje</CardTitle></CardHeader>
        <CardContent>
          <p class="text-muted-foreground">{{ linkError }}</p>
        </CardContent>
      </Card>

      <Card v-else-if="inactive">
        <CardHeader><CardTitle>Tento odkaz už nie je aktívny</CardTitle></CardHeader>
        <CardContent>
          <p class="text-muted-foreground">Skús sa obrátiť na osobu, ktorá ti odkaz poslala.</p>
        </CardContent>
      </Card>

      <Card v-else>
        <CardHeader>
          <CardTitle>Registrácia — Pekáreň</CardTitle>
        </CardHeader>
        <CardContent class="space-y-4">
          <Alert v-if="submitError" variant="destructive">
            <AlertDescription>{{ submitError }}</AlertDescription>
          </Alert>

          <form @submit.prevent="submit" class="space-y-4">
            <div class="space-y-2">
              <Label for="ob-name">Meno</Label>
              <Input id="ob-name" v-model="form.name" />
              <p v-if="fieldErrors.name" class="text-sm text-destructive">{{ fieldErrors.name }}</p>
            </div>

            <div class="space-y-2">
              <Label for="ob-phone">Mobil</Label>
              <Input id="ob-phone" v-model="form.phone" type="tel" autocomplete="tel" />
              <p v-if="fieldErrors.phone" class="text-sm text-destructive">{{ fieldErrors.phone }}</p>
            </div>

            <div class="space-y-2">
              <Label for="ob-email">Email <span class="text-muted-foreground text-xs">(nepovinné)</span></Label>
              <Input id="ob-email" v-model="form.email" type="email" autocomplete="email" />
              <p v-if="fieldErrors.email" class="text-sm text-destructive">{{ fieldErrors.email }}</p>
            </div>

            <div class="space-y-2">
              <Label for="ob-username">Užívateľské meno</Label>
              <Input id="ob-username" v-model="form.username" autocomplete="username" />
              <p v-if="usernameStatus === 'available'" class="text-sm text-emerald-600">Voľné</p>
              <p v-else-if="fieldErrors.username" class="text-sm text-destructive">{{ fieldErrors.username }}</p>
              <p v-else-if="usernameStatus === 'checking'" class="text-sm text-muted-foreground">Kontrolujem…</p>
            </div>

            <div class="space-y-2">
              <Label for="ob-password">Heslo</Label>
              <Input id="ob-password" v-model="form.password" type="password" autocomplete="new-password" />
              <p v-if="fieldErrors.password" class="text-sm text-destructive">{{ fieldErrors.password }}</p>
            </div>

            <Button type="submit" class="w-full" :disabled="submitting">
              {{ submitting ? 'Posielam…' : 'Vytvoriť účet' }}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
