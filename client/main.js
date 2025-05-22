const form = document.getElementById('form')
const urlInput = document.getElementById('url')
const statusText = document.getElementById('status')
const submitBtn = document.getElementById('submitBtn')

form.onsubmit = async (e) => {
  e.preventDefault()
  const url = urlInput.value.trim()

  if (!isValidUrl(url)) {
    statusText.textContent = '❌ Invalid URL'
    return
  }

  setLoading(true)
  statusText.textContent = '⏳ Starting download...'

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
  submitBtn.disabled = isLoading
  urlInput.disabled = isLoading
  form.classList.toggle('loading', isLoading)
}

async function pollStatus(id) {
  const interval = setInterval(async () => {
    try {
      const res = await fetch(`/status/${id}`)
      if (!res.ok) throw new Error('Status check failed')

      const { status } = await res.json()
      statusText.textContent = `📡 Download status: ${status}`

      if (status === 'done') {
        clearInterval(interval)
        statusText.textContent = '✅ Download ready. Saving file...'
        triggerDownload(id)
        setLoading(false)
      }

      if (status === 'error') {
        clearInterval(interval)
        statusText.textContent = '❌ Error during download'
        setLoading(false)
      }
    } catch (err) {
      clearInterval(interval)
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