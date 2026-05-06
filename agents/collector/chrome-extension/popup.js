// =============================================
// Reels Collector - Popup UI
// =============================================

document.addEventListener('DOMContentLoaded', () => {
  const statusText = document.getElementById('statusText');
  const totalCount = document.getElementById('totalCount');
  const pendingCount = document.getElementById('pendingCount');
  const reelsList = document.getElementById('reelsList');
  const btnStart = document.getElementById('btnStart');
  const btnStop = document.getElementById('btnStop');
  const btnExport = document.getElementById('btnExport');
  const btnClear = document.getElementById('btnClear');
  const categorySelect = document.getElementById('categorySelect');
  const modeSelect = document.getElementById('modeSelect');

  // 상태 업데이트
  function updateStatus() {
    chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
      if (!response) return;
      totalCount.textContent = response.totalCollected;
      statusText.textContent = response.isRunning ? '수집 중' : '중지됨';
      statusText.className = `value ${response.isRunning ? 'running' : 'stopped'}`;
      pendingCount.textContent = response.pendingSync;
      pendingCount.className = `value ${response.pendingSync > 0 ? 'warning' : ''}`;
      if (response.accountCategory) {
        categorySelect.value = response.accountCategory;
      }
      if (response.collectMode) {
        modeSelect.value = response.collectMode;
      }
    });
  }

  // 릴스 목록 표시
  function updateReelsList() {
    chrome.runtime.sendMessage({ action: 'exportData' }, (response) => {
      if (!response || !response.data || response.data.length === 0) {
        reelsList.innerHTML = '<div class="empty">수집된 릴스가 없습니다</div>';
        return;
      }

      const recent = response.data.slice(-20).reverse();
      reelsList.innerHTML = recent.map(reel => `
        <div class="reel-item">
          <div class="reel-url">${reel.url}</div>
          <div class="reel-meta">
            ${reel.author ? '@' + reel.author : ''}
            ${reel.views_text ? ' | ' + reel.views_text : ''}
            ${reel.account_category ? ' | ' + reel.account_category : ''}
            | ${new Date(reel.collected_at).toLocaleString('ko-KR')}
          </div>
        </div>
      `).join('');
    });
  }

  // 카테고리 변경
  categorySelect.addEventListener('change', () => {
    chrome.runtime.sendMessage({
      action: 'setCategory',
      category: categorySelect.value
    });
  });

  // 모드 변경
  modeSelect.addEventListener('change', () => {
    chrome.runtime.sendMessage({
      action: 'setMode',
      mode: modeSelect.value
    });
  });

  // 수집 시작
  btnStart.addEventListener('click', () => {
    if (!categorySelect.value) {
      alert('카테고리를 먼저 선택하세요.');
      return;
    }
    chrome.runtime.sendMessage({ action: 'startCollecting' }, () => {
      updateStatus();
    });
  });

  // 수집 중지
  btnStop.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'stopCollecting' }, () => {
      updateStatus();
    });
  });

  // JSON 내보내기
  btnExport.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'exportData' }, (response) => {
      if (!response || !response.data) return;
      const blob = new Blob(
        [JSON.stringify(response.data, null, 2)],
        { type: 'application/json' }
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `reels_${categorySelect.value || 'all'}_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  // 데이터 초기화
  btnClear.addEventListener('click', () => {
    if (confirm('수집된 모든 데이터를 삭제하시겠습니까?')) {
      chrome.runtime.sendMessage({ action: 'clearData' }, () => {
        updateStatus();
        updateReelsList();
      });
    }
  });

  // 초기 로드
  updateStatus();
  updateReelsList();
});
