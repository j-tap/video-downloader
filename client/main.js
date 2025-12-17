const form = document.getElementById('form')
const urlInput = document.getElementById('url')
const statusText = document.getElementById('status')
const submitBtn = document.getElementById('submitBtn')
const spinner = document.getElementById('spinner')
const progressContainer = document.getElementById('progressContainer')
const progressBar = document.getElementById('progressBar')
const progressText = document.getElementById('progressText')

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
    pollStatus(id)
  } catch (err) {
    statusText.textContent = '❌ ' + err.message
    setLoading(false)
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
  form.classList.toggle('loading', isLoading)

  if (isLoading) {
    spinner.classList.remove('hidden')
  } else {
    spinner.classList.add('hidden')
  }
}

async function pollStatus(id) {
  const interval = setInterval(async () => {
    try {
      const res = await fetch(`/status/${id}`)
      if (!res.ok) throw new Error('Status check failed')

      const { status, error, progress } = await res.json()
      
      // Обновляем прогресс если он есть
      if (progress !== undefined && progress !== null) {
        progressContainer.classList.remove('hidden')
        progressBar.style.width = `${progress}%`
        progressText.textContent = `${Math.round(progress)}%`
        statusText.textContent = `📡 Downloading... ${Math.round(progress)}%`
      } else {
        statusText.textContent = `📡 Download status: ${status}`
      }

      if (status === 'done') {
        clearInterval(interval)
        progressBar.style.width = '100%'
        progressText.textContent = '100%'
        statusText.textContent = '✅ Download ready. Saving file...'
        triggerDownload(id)
        setLoading(false)
        setTimeout(() => {
          progressContainer.classList.add('hidden')
        }, 2000)
      }

      if (status === 'error') {
        clearInterval(interval)
        progressContainer.classList.add('hidden')
        statusText.textContent = `❌ Download failed: ${error || 'Unknown error'}`
        setLoading(false)
      }
    } catch (err) {
      clearInterval(interval)
      progressContainer.classList.add('hidden')
      statusText.textContent = '❌ ' + err.message
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
