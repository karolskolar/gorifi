<script setup>
const isStaging = import.meta.env.VITE_STAGING === 'true'
</script>

<template>
  <div class="min-h-screen bg-gray-50">
    <div v-if="isStaging" class="bg-amber-500 text-amber-950 text-center py-1 text-sm font-medium">
      STAGING
    </div>
    <router-view />
  </div>
</template>
