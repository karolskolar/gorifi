<script setup>
import { ref, computed, onMounted, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const router = useRouter()
const loading = ref(true)
const error = ref('')
const invitations = ref([])
const activeFilter = ref('pending') // 'pending' | 'processed' | 'rejected' | ''

onMounted(async () => {
  await loadInvitations()
})

watchEffect(() => {
  document.title = 'Pozvánky - Gorifi Admin'
})

async function loadInvitations() {
  loading.value = true
  error.value = ''
  try {
    invitations.value = await api.getInvitations(activeFilter.value || undefined)
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function setFilter(status) {
  activeFilter.value = status
  await loadInvitations()
}

async function updateStatus(id, status) {
  try {
    await api.updateInvitation(id, { status })
    await loadInvitations()
  } catch (e) {
    error.value = e.message
  }
}

async function deleteInvitation(id) {
  if (!confirm('Naozaj chcete vymazať túto pozvánku?')) return
  try {
    await api.deleteInvitation(id)
    await loadInvitations()
  } catch (e) {
    error.value = e.message
  }
}

function createFriendFromInvitation(invitation) {
  const params = new URLSearchParams({ create: '1', name: invitation.name })
  router.push(`/admin/friends?${params.toString()}`)
}

function formatDate(dateStr) {
  if (!dateStr) return '-'
  const d = new Date(dateStr)
  return d.toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function formatDateTime(dateStr) {
  if (!dateStr) return '-'
  const d = new Date(dateStr)
  return d.toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const pendingCount = computed(() => {
  if (activeFilter.value === 'pending') return invitations.value.length
  return null
})
</script>

<template>
  <div class="min-h-screen bg-background">
    <!-- Header -->
    <header class="bg-primary text-primary-foreground shadow">
      <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <div class="flex items-center gap-3">
          <button @click="router.push('/admin/dashboard')" class="hover:bg-primary-foreground/10 rounded p-1 transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z" clip-rule="evenodd" />
            </svg>
          </button>
          <h1 class="text-xl font-bold">Pozvánky</h1>
        </div>
      </div>
    </header>

    <main class="max-w-5xl mx-auto p-4 space-y-6">
      <Alert v-if="error" variant="destructive" class="mb-4">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <!-- Filter tabs -->
      <div class="flex gap-2">
        <Button
          :variant="activeFilter === 'pending' ? 'default' : 'outline'"
          size="sm"
          @click="setFilter('pending')"
        >
          Čakajúce
        </Button>
        <Button
          :variant="activeFilter === 'processed' ? 'default' : 'outline'"
          size="sm"
          @click="setFilter('processed')"
        >
          Spracované
        </Button>
        <Button
          :variant="activeFilter === 'rejected' ? 'default' : 'outline'"
          size="sm"
          @click="setFilter('rejected')"
        >
          Zamietnuté
        </Button>
        <Button
          :variant="activeFilter === '' ? 'default' : 'outline'"
          size="sm"
          @click="setFilter('')"
        >
          Všetky
        </Button>
      </div>

      <div v-if="loading" class="text-center py-12 text-muted-foreground">
        Načítavam...
      </div>

      <Card v-else-if="invitations.length === 0">
        <CardContent class="py-12 text-center text-muted-foreground">
          Žiadne pozvánky
        </CardContent>
      </Card>

      <Card v-else>
        <CardContent class="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Meno</TableHead>
                <TableHead>Telefón</TableHead>
                <TableHead class="hidden sm:table-cell">Email</TableHead>
                <TableHead>Pozval/a</TableHead>
                <TableHead class="hidden sm:table-cell">Dátum</TableHead>
                <TableHead class="text-right">Akcie</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="inv in invitations" :key="inv.id">
                <TableCell class="font-medium">
                  {{ inv.name }}
                  <Badge v-if="inv.status === 'pending'" variant="outline" class="ml-2 text-xs text-yellow-600 border-yellow-600/30">Čaká</Badge>
                  <Badge v-else-if="inv.status === 'processed'" variant="outline" class="ml-2 text-xs text-green-600 border-green-600/30">Spracované</Badge>
                  <Badge v-else-if="inv.status === 'rejected'" variant="outline" class="ml-2 text-xs text-red-600 border-red-600/30">Zamietnuté</Badge>
                </TableCell>
                <TableCell>
                  <a :href="'tel:' + inv.phone" class="text-primary hover:underline">{{ inv.phone }}</a>
                </TableCell>
                <TableCell class="hidden sm:table-cell">
                  <template v-if="inv.email">
                    <a :href="'mailto:' + inv.email" class="text-primary hover:underline">{{ inv.email }}</a>
                  </template>
                  <span v-else class="text-muted-foreground">-</span>
                </TableCell>
                <TableCell>
                  <span>{{ inv.inviter_name }}</span>
                  <span class="text-xs text-muted-foreground ml-1">({{ inv.inviter_uid }})</span>
                </TableCell>
                <TableCell class="hidden sm:table-cell text-muted-foreground text-sm">
                  {{ formatDate(inv.created_at) }}
                </TableCell>
                <TableCell class="text-right">
                  <div class="flex items-center justify-end gap-1">
                    <template v-if="inv.status === 'pending'">
                      <Button size="sm" variant="outline" @click="createFriendFromInvitation(inv)" title="Vytvoriť priateľa">
                        Vytvoriť
                      </Button>
                      <Button size="sm" variant="outline" class="text-green-600 hover:text-green-700" @click="updateStatus(inv.id, 'processed')">
                        Spracované
                      </Button>
                      <Button size="sm" variant="ghost" class="text-destructive hover:text-destructive" @click="updateStatus(inv.id, 'rejected')">
                        Zamietnuť
                      </Button>
                    </template>
                    <template v-else>
                      <Button size="sm" variant="ghost" class="text-destructive hover:text-destructive" @click="deleteInvitation(inv.id)">
                        Vymazať
                      </Button>
                    </template>
                  </div>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </main>
  </div>
</template>
