// The control under the headline: a shuttle carrying a thread between your Mac and the cloud.
// Each crossing lays one more pick, and the screenshot below follows the session across.

const shed = document.querySelector('.shed')
const picks = document.querySelector('.picks')
const bobbin = document.querySelector('.bobbin')
const log = document.querySelector('.log')
const ends = [...document.querySelectorAll('.end')]
const shots = [...document.querySelectorAll('.shot img')]

const MOST_PICKS = 7

const LINES = {
  cloud: 'Moved from your Mac to the cloud, with its branches and uncommitted files.',
  mac: 'Moved from the cloud to your Mac, with its branches and uncommitted files.',
}

let at = 'mac'
let crossings = 0

function place() {
  const row = Math.min(crossings, MOST_PICKS)
  const across = at === 'cloud' ? shed.clientWidth - bobbin.clientWidth : 0

  // The shuttle rides on the newest pick, so it sinks a row with every crossing.
  bobbin.style.transform = `translate(${across}px, ${Math.max(0, row - 1) * 5}px)`
}

function show(name) {
  for (const image of shots) {
    const on = image.dataset.at === name

    if (on && !image.src) {
      image.src = image.dataset.src
    }

    image.classList.toggle('is-on', on)
  }
}

function cross(to) {
  if (to === at) {
    return
  }

  const pick = document.createElement('div')

  pick.className = `pick ${to === 'cloud' ? 'from-left' : 'from-right'}`
  picks.append(pick)

  // The cloth only has room for so many rows; the oldest gives way.
  while (picks.children.length > MOST_PICKS) {
    picks.firstElementChild.remove()
  }

  at = to
  crossings += 1

  // Read once so the browser has the pick at rest before it is asked to draw it across.
  void pick.offsetWidth
  pick.classList.add('is-laid')
  place()

  for (const end of ends) {
    end.setAttribute('aria-pressed', String(end.dataset.to === at))
  }

  log.textContent = LINES[at]
  show(at === 'cloud' ? 'cloud' : 'back')
}

for (const end of ends) {
  end.addEventListener('click', () => cross(end.dataset.to))
}

shed.addEventListener('click', () => cross(at === 'mac' ? 'cloud' : 'mac'))
window.addEventListener('resize', place)

// The other two screenshots are fetched once the page has settled, so the first crossing is ready.
window.addEventListener('load', () => {
  for (const image of shots) {
    if (!image.src && image.dataset.src) {
      new Image().src = image.dataset.src
    }
  }
})
