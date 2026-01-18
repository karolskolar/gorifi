<script setup>
import { ref, onMounted, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'

const router = useRouter()
const password = ref('')
const error = ref('')
const loading = ref(false)
const isSetup = ref(true)

onMounted(async () => {
  // Check if already logged in
  const token = localStorage.getItem('adminToken')
  if (token) {
    try {
      const { valid } = await api.verify(token)
      if (valid) {
        router.push('/admin/dashboard')
        return
      }
    } catch {
      localStorage.removeItem('adminToken')
    }
  }

  // Check if setup is needed
  try {
    const { isSetup: setupDone } = await api.checkSetup()
    isSetup.value = setupDone
  } catch (e) {
    error.value = e.message
  }
})

// Set page title
watchEffect(() => {
  document.title = 'Admin'
})

async function handleSubmit() {
  if (!password.value) {
    error.value = 'Zadajte heslo'
    return
  }

  loading.value = true
  error.value = ''

  try {
    if (!isSetup.value) {
      await api.setup(password.value)
      isSetup.value = true
    }

    const { token } = await api.login(password.value)
    localStorage.setItem('adminToken', token)
    router.push('/admin/dashboard')
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-background">
    <Card class="w-full max-w-md">
      <CardHeader class="text-center">
        <CardTitle class="text-3xl">Gorifi</CardTitle>
        <CardDescription>Správa objednávok kávy</CardDescription>
      </CardHeader>

      <CardContent>
        <form @submit.prevent="handleSubmit" class="space-y-4">
          <div class="space-y-2">
            <Label for="password">
              {{ isSetup ? 'Admin heslo' : 'Nastavte admin heslo' }}
            </Label>
            <Input
              id="password"
              v-model="password"
              type="password"
              :placeholder="isSetup ? 'Zadajte heslo' : 'Zvoľte heslo (min. 4 znaky)'"
            />
          </div>

          <Alert v-if="error" variant="destructive">
            <AlertDescription>{{ error }}</AlertDescription>
          </Alert>

          <Button type="submit" :disabled="loading" class="w-full">
            {{ loading ? 'Načítavam...' : (isSetup ? 'Prihlásiť sa' : 'Nastaviť heslo') }}
          </Button>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
