<script setup>
import { ref, onMounted, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Switch } from '@/components/ui/switch'

const router = useRouter()
const friends = ref([])
const loading = ref(true)
const error = ref('')

// Modal state
const showModal = ref(false)
const editingFriend = ref(null)
const friendName = ref('')

onMounted(async () => {
  await loadFriends()
})

// Set page title
watchEffect(() => {
  document.title = 'Admin'
})

async function loadFriends() {
  loading.value = true
  try {
    friends.value = await api.getFriends()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function openModal(friend = null) {
  editingFriend.value = friend
  friendName.value = friend ? friend.name : ''
  showModal.value = true
}

async function saveFriend() {
  if (!friendName.value.trim()) return

  try {
    if (editingFriend.value) {
      await api.updateFriend(editingFriend.value.id, { name: friendName.value })
    } else {
      await api.createFriend(friendName.value)
    }
    showModal.value = false
    friendName.value = ''
    editingFriend.value = null
    await loadFriends()
  } catch (e) {
    error.value = e.message
  }
}

async function toggleActive(friend) {
  try {
    await api.updateFriend(friend.id, { active: !friend.active })
    await loadFriends()
  } catch (e) {
    error.value = e.message
  }
}

async function deleteFriend(id) {
  if (!confirm('Naozaj vymazať tohto priateľa? Všetky jeho objednávky budú stratené.')) return

  try {
    await api.deleteFriend(id)
    await loadFriends()
  } catch (e) {
    error.value = e.message
  }
}

function goToDashboard() {
  router.push('/admin/dashboard')
}

async function logout() {
  await api.logout()
  localStorage.removeItem('adminToken')
  router.push('/admin')
}
</script>

<template>
  <div class="min-h-screen bg-background">
    <!-- Header -->
    <header class="bg-primary text-primary-foreground shadow">
      <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <div class="flex items-center gap-4">
          <Button variant="ghost" size="icon" @click="goToDashboard" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </Button>
          <h1 class="text-xl font-bold">Priatelia</h1>
        </div>
        <Button variant="ghost" @click="logout" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
          Odhlásiť sa
        </Button>
      </div>
    </header>

    <!-- Main content -->
    <main class="max-w-7xl mx-auto px-4 py-8">
      <div class="flex justify-between items-center mb-6">
        <h2 class="text-2xl font-bold text-foreground">Správa priateľov ({{ friends.length }})</h2>
        <Button @click="openModal()">
          + Pridať priateľa
        </Button>
      </div>

      <Alert v-if="error" variant="destructive" class="mb-4">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <div v-if="loading" class="text-center py-12 text-muted-foreground">
        Načítavam...
      </div>

      <div v-else-if="friends.length === 0" class="text-center py-12">
        <p class="text-muted-foreground mb-4">Zatiaľ žiadni priatelia</p>
        <Button @click="openModal()">
          Pridať prvého priateľa
        </Button>
      </div>

      <Card v-else>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Meno</TableHead>
              <TableHead class="text-center">Stav</TableHead>
              <TableHead class="text-right">Akcie</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="friend in friends" :key="friend.id">
              <TableCell class="font-medium">{{ friend.name }}</TableCell>
              <TableCell class="text-center">
                <div class="flex items-center justify-center gap-4">
                  <Switch
                    :checked="!!friend.active"
                    @update:checked="toggleActive(friend)"
                  />
                  <Badge :variant="friend.active ? 'default' : 'secondary'">
                    {{ friend.active ? 'Aktívny' : 'Neaktívny' }}
                  </Badge>
                </div>
              </TableCell>
              <TableCell class="text-right">
                <Button variant="ghost" size="sm" @click="openModal(friend)">Upraviť</Button>
                <Button variant="ghost" size="sm" class="text-destructive hover:text-destructive" @click="deleteFriend(friend.id)">Vymazať</Button>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Card>

      <Card class="mt-6">
        <CardContent class="p-4">
          <p class="text-sm text-muted-foreground">
            <strong>Tip:</strong> Aktívni priatelia sa zobrazujú vo výbere pri objednávaní vo všetkých cykloch.
            Neaktívnych priateľov môžete kedykoľvek znova aktivovať.
          </p>
        </CardContent>
      </Card>
    </main>

    <!-- Add/Edit Friend Modal -->
    <Dialog :open="showModal" @update:open="showModal = $event">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{{ editingFriend ? 'Upraviť priateľa' : 'Nový priateľ' }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-4 py-4">
          <div class="space-y-2">
            <Label>Meno priateľa</Label>
            <Input
              v-model="friendName"
              placeholder="Zadajte meno"
              @keyup.enter="saveFriend"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="showModal = false">
            Zrušiť
          </Button>
          <Button @click="saveFriend">
            {{ editingFriend ? 'Uložiť' : 'Pridať' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
