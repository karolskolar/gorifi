<script setup>
import { ref, computed, onMounted, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const router = useRouter()
const loading = ref(true)
const error = ref('')
const groups = ref([])
const unassigned = ref([])

// Modal state
const showAssignModal = ref(false)
const assigningFriend = ref(null)
const selectedRootId = ref('')

// Add root modal
const showAddRootModal = ref(false)
const selectedNewRootId = ref('')

onMounted(async () => {
  await loadGroups()
})

watchEffect(() => {
  document.title = 'Skupiny priateľov - Gorifi Admin'
})

async function loadGroups() {
  loading.value = true
  error.value = ''
  try {
    const data = await api.getFriendGroups()
    groups.value = data.groups
    unassigned.value = data.unassigned
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function removeRoot(rootId) {
  const group = groups.value.find(g => g.rootFriend.id === rootId)
  const hasSiblings = group && group.siblings.length > 0
  if (hasSiblings && !confirm('Tento priateľ má priradených členov. Všetci budú presunutí medzi nepriradených. Pokračovať?')) return

  try {
    await api.setRootStatus(rootId, false, hasSiblings)
    await loadGroups()
  } catch (e) {
    error.value = e.message
  }
}

async function removeSibling(friendId) {
  try {
    await api.assignRoot(friendId, null)
    await loadGroups()
  } catch (e) {
    error.value = e.message
  }
}

function openAssignModal(friend) {
  assigningFriend.value = friend
  selectedRootId.value = ''
  showAssignModal.value = true
}

async function confirmAssign() {
  if (!selectedRootId.value) return
  try {
    await api.assignRoot(assigningFriend.value.id, parseInt(selectedRootId.value))
    showAssignModal.value = false
    await loadGroups()
  } catch (e) {
    error.value = e.message
  }
}

function openAddRootModal() {
  selectedNewRootId.value = ''
  showAddRootModal.value = true
}

async function confirmAddRoot() {
  if (!selectedNewRootId.value) return
  try {
    await api.setRootStatus(parseInt(selectedNewRootId.value), true)
    showAddRootModal.value = false
    await loadGroups()
  } catch (e) {
    error.value = e.message
  }
}

// All non-root friends for assignment dropdown
const assignableToRoot = computed(() => {
  return unassigned.value.filter(f => f.id !== assigningFriend.value?.id)
})

// Candidates for new root: unassigned friends
const rootCandidates = computed(() => {
  return unassigned.value
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
          <h1 class="text-xl font-bold">Skupiny priateľov</h1>
        </div>
        <div class="flex items-center gap-2">
          <Button variant="ghost" @click="router.push('/admin/analytics/rewards')" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
            Report odmien
          </Button>
        </div>
      </div>
    </header>

    <main class="max-w-4xl mx-auto p-4 space-y-6">
      <Alert v-if="error" variant="destructive" class="mb-4">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <div v-if="loading" class="text-center py-12 text-muted-foreground">
        Načítavam...
      </div>

      <template v-else>
        <!-- Actions -->
        <div class="flex justify-between items-center">
          <p class="text-sm text-muted-foreground">
            {{ groups.length }} {{ groups.length === 1 ? 'skupina' : 'skupín' }}, {{ unassigned.length }} nepriradených
          </p>
          <Button @click="openAddRootModal" :disabled="unassigned.length === 0">
            + Pridať hlavného priateľa
          </Button>
        </div>

        <!-- Groups -->
        <div class="space-y-4">
          <Card v-for="group in groups" :key="group.rootFriend.id">
            <CardHeader class="pb-3">
              <div class="flex justify-between items-center">
                <CardTitle class="text-lg flex items-center gap-2">
                  {{ group.rootFriend.displayName || group.rootFriend.name }}
                  <Badge variant="outline" class="text-xs">Hlavný</Badge>
                </CardTitle>
                <div class="flex items-center gap-2">
                  <span class="text-sm text-muted-foreground">{{ group.siblings.length + 1 }} {{ group.siblings.length === 0 ? 'člen' : 'členov' }}</span>
                  <Button variant="ghost" size="sm" class="text-destructive hover:text-destructive" @click="removeRoot(group.rootFriend.id)">
                    Zrušiť
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div class="flex flex-wrap gap-2">
                <Badge
                  v-for="sibling in group.siblings"
                  :key="sibling.id"
                  variant="secondary"
                  class="pl-3 pr-1 py-1 flex items-center gap-1"
                >
                  {{ sibling.displayName || sibling.name }}
                  <button
                    @click="removeSibling(sibling.id)"
                    class="ml-1 rounded-full hover:bg-muted p-0.5"
                    title="Odstrániť zo skupiny"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                      <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
                    </svg>
                  </button>
                </Badge>
                <button
                  v-if="unassigned.length > 0"
                  @click="openAssignModal({ _targetRootId: group.rootFriend.id })"
                  class="border border-dashed border-muted-foreground/30 rounded-md px-3 py-1 text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                >
                  + Pridať člena
                </button>
              </div>
              <p v-if="group.siblings.length === 0 && unassigned.length === 0" class="text-sm text-muted-foreground">
                Žiadni členovia. Pridajte priateľov do tejto skupiny.
              </p>
            </CardContent>
          </Card>
        </div>

        <!-- Unassigned -->
        <Card v-if="unassigned.length > 0">
          <CardHeader class="pb-3">
            <CardTitle class="text-lg flex items-center gap-2">
              Ostatní
              <Badge variant="outline" class="text-xs bg-gray-50">Nepriradení</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div class="flex flex-wrap gap-2">
              <Badge
                v-for="friend in unassigned"
                :key="friend.id"
                variant="secondary"
                class="pl-3 pr-1 py-1 flex items-center gap-1 cursor-pointer hover:bg-muted"
                @click="openAssignModal(friend)"
              >
                {{ friend.displayName || friend.name }}
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3 ml-1 text-muted-foreground" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clip-rule="evenodd" />
                </svg>
              </Badge>
            </div>
          </CardContent>
        </Card>

        <!-- Empty state -->
        <div v-if="groups.length === 0 && unassigned.length === 0" class="text-center py-12">
          <p class="text-muted-foreground">Žiadni priatelia</p>
        </div>
      </template>
    </main>

    <!-- Assign to root modal -->
    <Dialog :open="showAssignModal" @update:open="showAssignModal = $event">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <template v-if="assigningFriend?._targetRootId">Pridať člena do skupiny</template>
            <template v-else>Priradiť do skupiny</template>
          </DialogTitle>
        </DialogHeader>
        <div class="space-y-4 py-4">
          <!-- If assigning from unassigned list, show root picker -->
          <template v-if="!assigningFriend?._targetRootId">
            <p class="text-sm text-muted-foreground">
              Priradiť <strong>{{ assigningFriend?.displayName || assigningFriend?.name }}</strong> do skupiny:
            </p>
            <Select v-model="selectedRootId">
              <SelectTrigger>
                <SelectValue placeholder="Vyberte hlavného priateľa" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="group in groups" :key="group.rootFriend.id" :value="String(group.rootFriend.id)">
                  {{ group.rootFriend.displayName || group.rootFriend.name }}
                </SelectItem>
              </SelectContent>
            </Select>
          </template>
          <!-- If adding member to specific group, show friend picker -->
          <template v-else>
            <Select v-model="selectedRootId">
              <SelectTrigger>
                <SelectValue placeholder="Vyberte priateľa" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="friend in unassigned" :key="friend.id" :value="String(friend.id)">
                  {{ friend.displayName || friend.name }}
                </SelectItem>
              </SelectContent>
            </Select>
          </template>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="showAssignModal = false">Zrušiť</Button>
          <Button
            @click="assigningFriend?._targetRootId
              ? api.assignRoot(parseInt(selectedRootId), assigningFriend._targetRootId).then(loadGroups).then(() => showAssignModal = false).catch(e => error = e.message)
              : confirmAssign()"
            :disabled="!selectedRootId"
          >
            Priradiť
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Add root modal -->
    <Dialog :open="showAddRootModal" @update:open="showAddRootModal = $event">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pridať hlavného priateľa</DialogTitle>
        </DialogHeader>
        <div class="space-y-4 py-4">
          <p class="text-sm text-muted-foreground">Vyberte priateľa, ktorý sa stane hlavným priateľom (vedúcim skupiny):</p>
          <Select v-model="selectedNewRootId">
            <SelectTrigger>
              <SelectValue placeholder="Vyberte priateľa" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="friend in rootCandidates" :key="friend.id" :value="String(friend.id)">
                {{ friend.displayName || friend.name }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="showAddRootModal = false">Zrušiť</Button>
          <Button @click="confirmAddRoot" :disabled="!selectedNewRootId">Pridať</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
