<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

const route = useRoute()

const state = ref('loading') // loading | form | success | invalid
const inviterName = ref('')
const error = ref('')
const submitting = ref(false)

const name = ref('')
const phone = ref('')
const email = ref('')

onMounted(async () => {
  try {
    const data = await api.validateInviteCode(route.params.code)
    inviterName.value = data.inviterName
    state.value = 'form'
  } catch (e) {
    state.value = 'invalid'
  }
})

async function submit() {
  error.value = ''

  if (!name.value.trim() || !phone.value.trim()) {
    error.value = 'Meno a telefón sú povinné'
    return
  }

  submitting.value = true
  try {
    await api.submitInvitation({
      invite_code: route.params.code,
      name: name.value.trim(),
      phone: phone.value.trim(),
      email: email.value.trim() || null
    })
    state.value = 'success'
  } catch (e) {
    error.value = e.message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="min-h-screen bg-background flex items-center justify-center p-4">
    <div class="w-full max-w-md">
      <!-- Logo -->
      <div class="flex justify-center mb-6">
        <img
          src="https://www.goriffee.com/wp-content/uploads/2024/02/01-GORIFFEE-Logo-RGB-400x110.png"
          alt="Goriffee"
          class="h-12 object-contain"
        />
      </div>

      <!-- Loading -->
      <div v-if="state === 'loading'" class="text-center py-12 text-muted-foreground">
        Overujem pozvánku...
      </div>

      <!-- Invalid code -->
      <Card v-else-if="state === 'invalid'">
        <CardContent class="pt-6 text-center space-y-4">
          <div class="text-4xl">😕</div>
          <h2 class="text-xl font-semibold">Neplatná pozvánka</h2>
          <p class="text-muted-foreground">
            Tento odkaz na pozvánku nie je platný alebo už neexistuje.
            Popros priateľa o nový odkaz.
          </p>
        </CardContent>
      </Card>

      <!-- Registration form -->
      <Card v-else-if="state === 'form'">
        <CardHeader>
          <CardTitle class="text-center">Registrácia</CardTitle>
          <p class="text-sm text-muted-foreground text-center mt-1">
            Pozval/a ťa: <strong>{{ inviterName }}</strong>
          </p>
        </CardHeader>
        <CardContent class="space-y-4">
          <Alert v-if="error" variant="destructive">
            <AlertDescription>{{ error }}</AlertDescription>
          </Alert>

          <div class="space-y-2">
            <Label for="name">Meno *</Label>
            <Input
              id="name"
              v-model="name"
              placeholder="Tvoje meno a priezvisko"
              @keyup.enter="submit"
            />
          </div>

          <div class="space-y-2">
            <Label for="phone">Telefón *</Label>
            <Input
              id="phone"
              v-model="phone"
              type="tel"
              placeholder="+421 9XX XXX XXX"
              @keyup.enter="submit"
            />
          </div>

          <div class="space-y-2">
            <Label for="email">Email <span class="text-muted-foreground font-normal">(pre zásielkovňu, voliteľné)</span></Label>
            <Input
              id="email"
              v-model="email"
              type="email"
              placeholder="tvoj@email.sk"
              @keyup.enter="submit"
            />
          </div>

          <Button class="w-full" @click="submit" :disabled="submitting">
            {{ submitting ? 'Odosielam...' : 'Odoslať registráciu' }}
          </Button>
        </CardContent>
      </Card>

      <!-- Success -->
      <Card v-else-if="state === 'success'">
        <CardContent class="pt-6 text-center space-y-4">
          <div class="text-4xl">✅</div>
          <h2 class="text-xl font-semibold">Ďakujeme!</h2>
          <p class="text-muted-foreground">
            Tvoja registrácia bola odoslaná. Admin ťa čoskoro pridá do skupiny a ozve sa ti.
          </p>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
