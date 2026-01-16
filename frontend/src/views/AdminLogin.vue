<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'

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
  <div class="min-h-screen flex items-center justify-center bg-amber-50">
    <div class="bg-white p-8 rounded-lg shadow-lg w-full max-w-md">
      <div class="text-center mb-8">
        <h1 class="text-3xl font-bold text-amber-800">Gorifi</h1>
        <p class="text-gray-600 mt-2">Sprava objednavok kavy</p>
      </div>

      <form @submit.prevent="handleSubmit">
        <div class="mb-4">
          <label class="block text-gray-700 text-sm font-medium mb-2">
            {{ isSetup ? 'Admin heslo' : 'Nastavte admin heslo' }}
          </label>
          <input
            v-model="password"
            type="password"
            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent"
            :placeholder="isSetup ? 'Zadajte heslo' : 'Zvolte heslo (min. 4 znaky)'"
          />
        </div>

        <div v-if="error" class="mb-4 p-3 bg-red-50 text-red-700 rounded-lg text-sm">
          {{ error }}
        </div>

        <button
          type="submit"
          :disabled="loading"
          class="w-full bg-amber-600 text-white py-2 px-4 rounded-lg font-medium hover:bg-amber-700 transition-colors disabled:opacity-50"
        >
          {{ loading ? 'Nacitavam...' : (isSetup ? 'Prihlasit sa' : 'Nastavit heslo') }}
        </button>
      </form>
    </div>
  </div>
</template>
