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

    if (!res.ok) {
      const error = await getResponseError(res)
      logClientError('Download start API error', { url, status: res.status, error })
      throw new Error(error || 'Failed to start download')
    }

    const { id } = await res.json()
    activeDownloadId = id
    pollStatus(id)
  } catch (err) {
    logClientError('Download start failed', { url }, err)
    statusText.textContent = `❌ ${err.message || 'Download failed'}`
    setLoading(false)
  }
}

cancelBtn.onclick = async () => {
  if (!activeDownloadId) return

  cancelBtn.disabled = true
  statusText.textContent = '⏳ Cancelling...'

  try {
    const res = await fetch(`/cancel/${activeDownloadId}`, { method: 'POST' })
    if (!res.ok) {
      const error = await getResponseError(res)
      logClientError('Cancel API error', { id: activeDownloadId, status: res.status, error })
      throw new Error(error || 'Cancel failed')
    }
    stopPolling()
    resetProgress()
    statusText.textContent = '⏹ Download cancelled'
    setLoading(false)
  } catch (err) {
    logClientError('Cancel failed', { id: activeDownloadId }, err)
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
      if (!res.ok) {
        const error = await getResponseError(res)
        logClientError('Status API error', { id, status: res.status, error })
        throw new Error(error || 'Status check failed')
      }

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
        logClientError('Download processing error', { id, error, progress, status })
        stopPolling()
        resetProgress()
        statusText.textContent = `❌ ${error || 'Download failed'}`
        setLoading(false)
      }
    } catch (err) {
      stopPolling()
      resetProgress()
      logClientError('Status check failed', { id }, err)
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

async function getResponseError(response) {
  try {
    const body = await response.json()
    return body?.error
  } catch {
    return null
  }
}

function logClientError(message, context = {}, error) {
  if (error) {
    console.error(`[video-downloader] ${message}`, context, error)
    return
  }

  console.error(`[video-downloader] ${message}`, context)
}
