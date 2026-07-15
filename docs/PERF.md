# 수동 성능 체크리스트

PLAN_v2.md §7의 리스크("1만 필드 성능은 jsdom으로 실측 불가")에 대한 대응. jsdom은 파싱·집계 시간은 재지만 실제 레이아웃·페인트 비용은 재지 못하므로, 아래는 브라우저에서 손으로 확인한다.

## 자동으로 측정되는 것 (jsdom)

배치 파싱 + 점수 계산 + 대시보드 DOM 생성까지. 참고 수치 (2026-07-15, M-series macOS, node 26):

| 배치 | 필드 수 | 업로드→대시보드 |
|---|---|---|
| 500건 | 2,000 | 23ms |
| 2,000건 | 8,000 | 30ms |

재현:
```bash
npm run build
node -e '
const {JSDOM}=require("jsdom");const fs=require("fs");
const w=new JSDOM(fs.readFileSync("index.html","utf8"),{runScripts:"dangerously",pretendToBeVisual:true}).window;
const jsonl=w.eval("demoBatch(500)");
const t=Date.now();
w.document.getElementById("tabBatchPaste").click();
w.document.getElementById("batchIn").value=jsonl;
w.document.getElementById("loadBatch").click();
console.log(Date.now()-t+"ms",[...w.document.querySelectorAll("#batchStats .stat b")].map(e=>e.textContent));
'
```

## 손으로 확인할 것 (브라우저)

실제 Chrome/Firefox/Safari에서, 위 스니펫의 `demoBatch(2500)` 출력을 파일로 저장해 업로드한 뒤:

- [ ] **업로드 후 첫 페인트**: 대시보드가 1초 안에 뜨는가. 스피너 없이 멈춘 것처럼 보이는 구간이 없는가.
- [ ] **히스토그램**: 28개 막대가 정상적으로 그려지고 임계값 선이 보이는가.
- [ ] **필드 테이블**: 경로 수가 많아도(수십 행) 스크롤이 매끄러운가.
- [ ] **슬라이더 인터랙션**: 목표 정밀도 슬라이더를 좌우로 빠르게 드래그할 때 프레임 드랍이 체감되는가. (재피팅 + 히스토그램 + 테이블이 매 input마다 다시 그려진다 - 여기가 가장 먼저 무너질 지점이다.)
- [ ] **메모리**: 개발자도구 Memory 탭에서 배치 3회 연속 로드 후 힙이 계속 우상향하는가(누수).
- [ ] **Lens 히트맵**: 토큰 2,000개 이상인 긴 자유 텍스트 응답에서 호버 팝오버 지연이 있는가.

하나라도 걸리면 D-005(청킹 미도입)를 재검토한다.

## 알려진 한계

- 슬라이더 `input` 이벤트마다 전체 재계산이 돈다. 디바운스가 없다 - 캘리브레이션 셋 500건 기준으로는 체감되지 않지만, 사용자가 수만 건짜리 라벨 CSV를 넣으면 여기가 병목이다.
- `renderHist`/`renderPathTable`은 매번 innerHTML을 통째로 교체한다. 행이 수백 개가 되면 증분 갱신이 필요할 수 있다.
