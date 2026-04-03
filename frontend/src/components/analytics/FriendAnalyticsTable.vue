<script setup>
import { ref, computed } from 'vue'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const props = defineProps({
  friends: {
    type: Array,
    required: true,
  },
})

const SEGMENT_ORDER = ['core', 'regular', 'occasional', 'new', 'inactive']

const SEGMENT_BADGE_CLASSES = {
  core: 'bg-green-100 text-green-800',
  regular: 'bg-blue-100 text-blue-800',
  occasional: 'bg-amber-100 text-amber-800',
  new: 'bg-purple-100 text-purple-800',
  inactive: 'bg-gray-100 text-gray-600',
}

const SEGMENT_LABELS = {
  core: 'Jadro',
  regular: 'Pravidelný',
  occasional: 'Občasný',
  new: 'Nový',
  inactive: 'Neaktívny',
}

// Filter state
const activeFilter = ref(null)

// Sort state
const sortKey = ref('total_kg')
const sortAsc = ref(false)

// Segment counts
const segmentCounts = computed(() => {
  const counts = {}
  for (const seg of SEGMENT_ORDER) {
    counts[seg] = props.friends.filter((f) => (f.segment?.segment || 'inactive') === seg).length
  }
  return counts
})

const filterButtons = computed(() => [
  { key: null, label: `Všetci (${props.friends.length})` },
  ...SEGMENT_ORDER
    .filter((s) => segmentCounts.value[s] > 0)
    .map((s) => ({
      key: s,
      label: `${SEGMENT_LABELS[s]} (${segmentCounts.value[s]})`,
    })),
])

// Filtered + sorted friends
const filteredFriends = computed(() => {
  let list = props.friends
  if (activeFilter.value) {
    list = list.filter((f) => (f.segment?.segment || 'inactive') === activeFilter.value)
  }

  const key = sortKey.value
  const asc = sortAsc.value
  return [...list].sort((a, b) => {
    let va = a[key] ?? 0
    let vb = b[key] ?? 0
    if (typeof va === 'string') {
      va = va.toLowerCase()
      vb = (vb || '').toLowerCase()
      return asc ? va.localeCompare(vb) : vb.localeCompare(va)
    }
    return asc ? va - vb : vb - va
  })
})

function toggleSort(key) {
  if (sortKey.value === key) {
    sortAsc.value = !sortAsc.value
  } else {
    sortKey.value = key
    sortAsc.value = key === 'name'
  }
}

function toggleFilter(key) {
  activeFilter.value = activeFilter.value === key ? null : key
}

function sortIndicator(key) {
  if (sortKey.value !== key) return ''
  return sortAsc.value ? ' \u2191' : ' \u2193'
}
</script>

<template>
  <div>
    <!-- Segment filter buttons -->
    <div class="flex flex-wrap gap-2 mb-4">
      <Button
        v-for="btn in filterButtons"
        :key="btn.key"
        :variant="activeFilter === btn.key ? 'default' : 'outline'"
        size="sm"
        @click="toggleFilter(btn.key)"
      >
        {{ btn.label }}
      </Button>
    </div>

    <!-- Table -->
    <div class="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="cursor-pointer select-none" @click="toggleSort('name')">
              Meno{{ sortIndicator('name') }}
            </TableHead>
            <TableHead>Segment</TableHead>
            <TableHead class="cursor-pointer select-none text-right" @click="toggleSort('participation_rate')">
              Účasť{{ sortIndicator('participation_rate') }}
            </TableHead>
            <TableHead class="cursor-pointer select-none text-right" @click="toggleSort('avg_kg_per_cycle')">
              Priemer kg{{ sortIndicator('avg_kg_per_cycle') }}
            </TableHead>
            <TableHead class="cursor-pointer select-none text-right" @click="toggleSort('total_kg')">
              Celkové kg{{ sortIndicator('total_kg') }}
            </TableHead>
            <TableHead class="cursor-pointer select-none" @click="toggleSort('last_active_cycle_name')">
              Posledná obj.{{ sortIndicator('last_active_cycle_name') }}
            </TableHead>
            <TableHead class="cursor-pointer select-none text-right" @click="toggleSort('streak')">
              Séria{{ sortIndicator('streak') }}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow
            v-for="f in filteredFriends"
            :key="f.id"
            :class="{ 'opacity-50': !f.active }"
          >
            <TableCell class="font-medium">{{ f.name }}</TableCell>
            <TableCell>
              <Badge :class="SEGMENT_BADGE_CLASSES[f.segment?.segment || 'inactive']">
                {{ f.segment?.label || 'Neaktívny' }}
              </Badge>
            </TableCell>
            <TableCell class="text-right">
              {{ f.cycles_participated }}/{{ f.total_cycles }}
              <span class="text-muted-foreground text-xs ml-1">
                ({{ Math.round((f.participation_rate || 0) * 100) }}%)
              </span>
            </TableCell>
            <TableCell class="text-right">{{ (f.avg_kg_per_cycle || 0).toFixed(2) }}</TableCell>
            <TableCell class="text-right font-medium">{{ (f.total_kg || 0).toFixed(1) }}</TableCell>
            <TableCell>{{ f.last_active_cycle_name || '—' }}</TableCell>
            <TableCell class="text-right">
              {{ f.streak || 0 }}
              <span v-if="f.trend === 'up'" class="text-green-600 ml-1">&#9650;</span>
              <span v-else-if="f.trend === 'down'" class="text-red-600 ml-1">&#9660;</span>
              <span v-else class="text-gray-400 ml-1">&mdash;</span>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  </div>
</template>
