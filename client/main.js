const form = document.getElementById('form')
const urlInput = document.getElementById('url')
const statusText = document.getElementById('status')
const submitBtn = document.getElementById('submitBtn')
const cancelBtn = document.getElementById('cancelBtn')
const spinner = document.getElementById('spinner')
const progressContainer = document.getElementById('progressContainer')
const progressBar = document.getElementById('progressBar')
const progressText = document.getElementById('progressText')

let activeDownloadId = null
let pollInterval = null

form.onsubmit = async (e) => {
  e.preventDefault()
  const url = urlInput.value.trim()

  if (!isValidUrl(url)) {
    statusText.textContent = '❌ Invalid URL'
    return
  }

  setLoading(true)
  statusText.textContent = '⏳ Starting download...'
  progressContainer.classList.add('hidden')
  progressBar.style.width = '0%'

  try {
    const res = await fetch('/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    })

    if (!res.ok) throw new Error('Failed to start download')

    const { id } = await res.json()
    activeDownloadId = id
    pollStatus(id)
  } catch (err) {
    console.error('Download start failed:', err)
    statusText.textContent = '❌ Download failed'
    setLoading(false)
  }
}

cancelBtn.onclick = async () => {
  if (!activeDownloadId) return

  cancelBtn.disabled = true
  statusText.textContent = '⏳ Cancelling...'

  try {
    const res = await fetch(`/cancel/${activeDownloadId}`, { method: 'POST' })
    if (!res.ok) throw new Error('Cancel failed')
    stopPolling()
    resetProgress()
    statusText.textContent = '⏹ Download cancelled'
    setLoading(false)
  } catch (err) {
    console.error('Cancel failed:', err)
    statusText.textContent = '❌ Download failed'
    cancelBtn.disabled = false
  }
}

function isValidUrl(url) {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

function setLoading(isLoading) {
  urlInput.disabled = isLoading
  submitBtn.disabled = isLoading
  submitBtn.classList.toggle('hidden', isLoading)
  cancelBtn.classList.toggle('hidden', !isLoading)
  cancelBtn.disabled = false
  form.classList.toggle('loading', isLoading)

  if (isLoading) {
    spinner.classList.remove('hidden')
  } else {
    spinner.classList.add('hidden')
    activeDownloadId = null
  }
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
}

function resetProgress() {
  progressContainer.classList.add('hidden')
  progressBar.style.width = '0%'
  progressText.textContent = ''
}

async function pollStatus(id) {
  stopPolling()

  pollInterval = setInterval(async () => {
    try {
      const res = await fetch(`/status/${id}`)
      if (!res.ok) throw new Error('Status check failed')

      const { status, error, progress } = await res.json()

      if (progress !== undefined && progress !== null) {
        progressContainer.classList.remove('hidden')
        progressBar.style.width = `${progress}%`
        progressText.textContent = `${Math.round(progress)}%`
        statusText.textContent = `📡 Downloading... ${Math.round(progress)}%`
      } else if (status === 'pending') {
        statusText.textContent = '📡 Downloading...'
      }

      if (status === 'done') {
        stopPolling()
        progressBar.style.width = '100%'
        progressText.textContent = '100%'
        statusText.textContent = '✅ Download ready. Saving file...'
        triggerDownload(id)
        setLoading(false)
        setTimeout(resetProgress, 2000)
      }

      if (status === 'cancelled') {
        stopPolling()
        resetProgress()
        statusText.textContent = '⏹ Download cancelled'
        setLoading(false)
      }

      if (status === 'error') {
        stopPolling()
        resetProgress()
        statusText.textContent = '❌ Download failed'
        setLoading(false)
      }
    } catch (err) {
      stopPolling()
      resetProgress()
      console.error('Status check failed:', err)
      statusText.textContent = '❌ Download failed'
      setLoading(false)
    }
  }, 2000)
}

function triggerDownload(id) {
  const a = document.createElement('a')
  a.href = `/file/${id}`
  a.download = 'video.mp4'
  a.click()
}
