<script setup>
import { watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'

const router = useRouter()

watchEffect(() => {
  document.title = 'Štatistiky pekáreň - Gorifi Admin'
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
        <Button variant="outline" @click="router.push('/admin/analytics/live')">Živý prehľad</Button>
        <Button variant="outline" @click="router.push('/admin/analytics/coffee')">Káva</Button>
        <Button variant="default">Pekáreň</Button>
        <Button variant="outline" @click="router.push('/admin/analytics/rewards')">Odmeny</Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Štatistiky pekárne</CardTitle>
        </CardHeader>
        <CardContent>
          <p class="text-muted-foreground">Pripravujeme — štatistiky pre pekáreň budú dostupné čoskoro.</p>
        </CardContent>
      </Card>
    </main>
  </div>
</template>
