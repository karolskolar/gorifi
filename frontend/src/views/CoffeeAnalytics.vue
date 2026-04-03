<script setup>
import { ref, watchEffect, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'

const router = useRouter()
const loading = ref(true)
const error = ref('')
const data = ref(null)

watchEffect(() => {
  document.title = 'Štatistiky káva - Gorifi Admin'
})

onMounted(async () => {
  try {
    data.value = await api.getCoffeeAnalytics()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="min-h-screen bg-background">
    <header class="bg-primary text-primary-foreground shadow">
      <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <div class="flex items-center gap-4">
          <Button variant="ghost" size="icon" @click="router.push('/admin/dashboard')" class="text-primary-foreground hover:bg-primary-foreground/10">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </Button>
          <h1 class="text-xl font-bold">Štatistiky</h1>
        </div>
      </div>
    </header>

    <main class="max-w-7xl mx-auto px-4 py-8">
      <div class="flex gap-2 mb-6">
        <Button variant="default">Káva</Button>
        <Button variant="outline" @click="router.push('/admin/analytics/bakery')">Pekáreň</Button>
      </div>

      <Alert v-if="error" variant="destructive" class="mb-4">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <div v-if="loading" class="text-center py-12 text-muted-foreground">Načítavam...</div>

      <div v-else-if="data && data.cycles.length === 0" class="text-center py-12 text-muted-foreground">
        Žiadne dokončené kávové cykly na analýzu.
      </div>

      <div v-else-if="data" class="space-y-8">
        <p class="text-muted-foreground">Analytics data loaded: {{ data.cycles.length }} cycles, {{ data.friends.length }} friends.</p>
      </div>
    </main>
  </div>
</template>
