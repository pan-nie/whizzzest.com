const status = document.getElementById('music-status');
const list = document.getElementById('tracks');

function render(track, index) {
  const row = document.createElement('li');
  row.className = 'track';
  const info = document.createElement('div');
  info.className = 'track-info';
  if (track.cover) {
    const image = document.createElement('img');
    image.src = track.cover;
    image.alt = '';
    image.loading = 'lazy';
    info.append(image);
  }
  const details = document.createElement('div');
  const title = document.createElement('h3');
  title.id = 'track-' + (index + 1);
  title.textContent = track.title;
  details.append(title);
  if (track.artist) {
    const artist = document.createElement('p');
    artist.textContent = track.artist;
    details.append(artist);
  }
  if (track.description) {
    const description = document.createElement('p');
    description.textContent = track.description;
    details.append(description);
  }
  info.append(details);
  const player = document.createElement('audio');
  player.controls = true;
  player.preload = 'none';
  player.setAttribute('aria-labelledby', title.id);
  const source = document.createElement('source');
  source.src = track.url;
  source.type = track.type;
  player.append(source);
  player.addEventListener('play', () => {
    for (const other of list.querySelectorAll('audio')) {
      if (other !== player && !other.paused) other.pause();
    }
  });
  row.append(info, player);
  return row;
}

async function loadMusic() {
  try {
    const response = await fetch('/api/music');
    if (!response.ok) throw new Error('Could not load tracks');
    const { tracks } = await response.json();
    if (!tracks.length) {
      status.textContent = '首批作品制作中，发布后会出现在这里。';
      return;
    }
    list.replaceChildren(...tracks.map(render));
    list.hidden = false;
    status.hidden = true;
  } catch {
    status.textContent = '暂时无法加载曲目，请刷新页面重试。';
  }
}

loadMusic();
