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

// Members modal (multi-select)
const showMembersModal = ref(false)
const membersModalRootId = ref(null)
const selectedFriendIds = ref(new Set())

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

function openMembersModal(rootId) {
  membersModalRootId.value = rootId
  // Pre-select current members of this group
  const group = groups.value.find(g => g.rootFriend.id === rootId)
  selectedFriendIds.value = new Set(group ? group.siblings.map(s => s.id) : [])
  showMembersModal.value = true
}

// All friends available for this group: current siblings + unassigned
const membersModalFriends = computed(() => {
  const group = groups.value.find(g => g.rootFriend.id === membersModalRootId.value)
  const currentSiblings = group ? group.siblings : []
  return [...currentSiblings, ...unassigned.value].sort((a, b) =>
    a.name.localeCompare(b.name)
  )
})

function toggleFriend(friendId) {
  const newSet = new Set(selectedFriendIds.value)
  if (newSet.has(friendId)) {
    newSet.delete(friendId)
  } else {
    newSet.add(friendId)
  }
  selectedFriendIds.value = newSet
}

async function confirmMembers() {
  const rootId = membersModalRootId.value
  const group = groups.value.find(g => g.rootFriend.id === rootId)
  const currentSiblingIds = new Set(group ? group.siblings.map(s => s.id) : [])
  const newSelectedIds = selectedFriendIds.value

  // Friends to add (selected but not currently in group)
  const toAdd = [...newSelectedIds].filter(id => !currentSiblingIds.has(id))
  // Friends to remove (currently in group but not selected)
  const toRemove = [...currentSiblingIds].filter(id => !newSelectedIds.has(id))

  if (toAdd.length === 0 && toRemove.length === 0) {
    showMembersModal.value = false
    return
  }

  try {
    const promises = []
    if (toAdd.length > 0) {
      promises.push(api.batchAssignRoot(toAdd, rootId))
    }
    if (toRemove.length > 0) {
      promises.push(api.batchAssignRoot(toRemove, null))
    }
    await Promise.all(promises)
    showMembersModal.value = false
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
                  {{ group.rootFriend.name }}
                  <span v-if="group.rootFriend.display_name && group.rootFriend.display_name !== group.rootFriend.name" class="text-sm font-normal text-muted-foreground">({{ group.rootFriend.display_name }})</span>
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
                  {{ sibling.name }}<template v-if="sibling.display_name && sibling.display_name !== sibling.name"> <span class="text-muted-foreground">({{ sibling.display_name }})</span></template>
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
                  @click="openMembersModal(group.rootFriend.id)"
                  class="border border-dashed border-muted-foreground/30 rounded-md px-3 py-1 text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                >
                  + Upraviť členov
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
                class="px-3 py-1"
              >
                {{ friend.name }}<template v-if="friend.display_name && friend.display_name !== friend.name"> <span class="text-muted-foreground text-xs">({{ friend.display_name }})</span></template>
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

    <!-- Members multi-select modal -->
    <Dialog :open="showMembersModal" @update:open="showMembersModal = $event">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upraviť členov skupiny</DialogTitle>
        </DialogHeader>
        <div class="py-4">
          <p v-if="membersModalFriends.length === 0" class="text-sm text-muted-foreground">
            Žiadni priatelia na priradenie.
          </p>
          <div v-else class="space-y-1 max-h-80 overflow-y-auto">
            <label
              v-for="friend in membersModalFriends"
              :key="friend.id"
              class="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-muted cursor-pointer transition-colors"
            >
              <div
                class="h-5 w-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors"
                :class="selectedFriendIds.has(friend.id) ? 'bg-primary border-primary' : 'border-muted-foreground/40'"
              >
                <svg v-if="selectedFriendIds.has(friend.id)" xmlns="http://www.w3.org/2000/svg" class="h-3 w-3 text-primary-foreground" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                </svg>
              </div>
              <input
                type="checkbox"
                class="sr-only"
                :checked="selectedFriendIds.has(friend.id)"
                @change="toggleFriend(friend.id)"
              />
              <span class="text-sm">{{ friend.name }}<span v-if="friend.display_name && friend.display_name !== friend.name" class="text-muted-foreground ml-1">({{ friend.display_name }})</span></span>
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="showMembersModal = false">Zrušiť</Button>
          <Button @click="confirmMembers">
            Uložiť
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
                {{ friend.name }}<template v-if="friend.display_name && friend.display_name !== friend.name"> ({{ friend.display_name }})</template>
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
