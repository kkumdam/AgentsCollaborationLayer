const GRID_SIZE = 4;

let board = [];
let score = 0;
let bestScore = localStorage.getItem('2048-best') || 0;
let gameOver = false;
let won = false;

const scoreEl = document.getElementById('score');
const bestScoreEl = document.getElementById('best-score');
const tileContainer = document.getElementById('tile-container');
const gameMessage = document.getElementById('game-message');
const gameMessageText = document.getElementById('game-message-text');

bestScoreEl.textContent = bestScore;

function initBoard() {
  board = Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(0));
  score = 0;
  gameOver = false;
  won = false;
  scoreEl.textContent = 0;
  gameMessage.classList.add('hidden');
  tileContainer.innerHTML = '';
  addRandomTile();
  addRandomTile();
  renderTiles();
}

function getEmptyCells() {
  const cells = [];
  for (let r = 0; r < GRID_SIZE; r++)
    for (let c = 0; c < GRID_SIZE; c++)
      if (board[r][c] === 0) cells.push([r, c]);
  return cells;
}

function addRandomTile() {
  const empty = getEmptyCells();
  if (empty.length === 0) return;
  const [r, c] = empty[Math.floor(Math.random() * empty.length)];
  board[r][c] = Math.random() < 0.9 ? 2 : 4;
}

function renderTiles() {
  tileContainer.innerHTML = '';
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      if (board[r][c] !== 0) {
        createTileEl(r, c, board[r][c]);
      }
    }
  }
}

function createTileEl(r, c, value, merged = false) {
  const tile = document.createElement('div');
  const cls = value <= 2048 ? `tile-${value}` : 'tile-super';
  tile.className = `tile ${cls}${merged ? ' merged' : ''}`;
  tile.textContent = value;
  tile.style.gridRow = r + 1;
  tile.style.gridColumn = c + 1;
  tileContainer.appendChild(tile);
  return tile;
}

function slide(row) {
  const filtered = row.filter(v => v !== 0);
  const merged = [];
  let gain = 0;
  let i = 0;
  while (i < filtered.length) {
    if (i + 1 < filtered.length && filtered[i] === filtered[i + 1]) {
      merged.push({ value: filtered[i] * 2, wasMerged: true });
      gain += filtered[i] * 2;
      i += 2;
    } else {
      merged.push({ value: filtered[i], wasMerged: false });
      i++;
    }
  }
  while (merged.length < GRID_SIZE) merged.push({ value: 0, wasMerged: false });
  return { row: merged, gain };
}

function move(direction) {
  if (gameOver) return;

  let moved = false;
  let totalGain = 0;
  const newBoard = Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(0));
  const mergedCells = [];

  for (let i = 0; i < GRID_SIZE; i++) {
    let line = [];
    if (direction === 'left')  line = board[i].slice();
    if (direction === 'right') line = board[i].slice().reverse();
    if (direction === 'up')    line = board.map(r => r[i]);
    if (direction === 'down')  line = board.map(r => r[i]).reverse();

    const { row: result, gain } = slide(line);
    totalGain += gain;

    for (let j = 0; j < GRID_SIZE; j++) {
      let r, c;
      if (direction === 'left')  { r = i; c = j; }
      if (direction === 'right') { r = i; c = GRID_SIZE - 1 - j; }
      if (direction === 'up')    { r = j; c = i; }
      if (direction === 'down')  { r = GRID_SIZE - 1 - j; c = i; }

      const prev = board[r][c];
      newBoard[r][c] = result[j].value;
      if (prev !== result[j].value) moved = true;
      if (result[j].wasMerged && result[j].value !== 0) mergedCells.push([r, c]);
    }
  }

  if (!moved) return;

  board = newBoard;
  score += totalGain;
  scoreEl.textContent = score;
  if (score > bestScore) {
    bestScore = score;
    bestScoreEl.textContent = bestScore;
    localStorage.setItem('2048-best', bestScore);
  }

  addRandomTile();

  // Render with merge highlight
  tileContainer.innerHTML = '';
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      if (board[r][c] !== 0) {
        const isMerged = mergedCells.some(([mr, mc]) => mr === r && mc === c);
        createTileEl(r, c, board[r][c], isMerged);
      }
    }
  }

  if (!won && board.some(row => row.includes(2048))) {
    won = true;
    showMessage('게임 클리어!');
    return;
  }

  if (!canMove()) {
    gameOver = true;
    showMessage('게임 오버');
  }
}

function canMove() {
  if (getEmptyCells().length > 0) return true;
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      if (c + 1 < GRID_SIZE && board[r][c] === board[r][c + 1]) return true;
      if (r + 1 < GRID_SIZE && board[r][c] === board[r + 1][c]) return true;
    }
  }
  return false;
}

function showMessage(text) {
  gameMessageText.textContent = text;
  gameMessage.classList.remove('hidden');
}

document.addEventListener('keydown', e => {
  const map = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    a: 'left', d: 'right', w: 'up', s: 'down',
    A: 'left', D: 'right', W: 'up', S: 'down',
  };
  if (map[e.key]) {
    e.preventDefault();
    move(map[e.key]);
  }
});

// Touch support
let touchStartX = 0, touchStartY = 0;
document.addEventListener('touchstart', e => {
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
}, { passive: true });

document.addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = e.changedTouches[0].clientY - touchStartY;
  if (Math.abs(dx) < 20 && Math.abs(dy) < 20) return;
  if (Math.abs(dx) > Math.abs(dy)) {
    move(dx > 0 ? 'right' : 'left');
  } else {
    move(dy > 0 ? 'down' : 'up');
  }
}, { passive: true });

document.getElementById('new-game-btn').addEventListener('click', initBoard);
document.getElementById('retry-btn').addEventListener('click', initBoard);

initBoard();
