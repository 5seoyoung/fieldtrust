# 라이브 모드 접근성 검증 결과 (2026-07-18)

기획서 정리 3.2의 "Ollama 먼저, OpenAI 나중" 방향에 앞서, 두 백엔드가 브라우저에서 실제로 도달 가능한지 배포된 라이브 사이트(`https://5seoyoung.github.io/fieldtrust/`)에서 fetch를 날려 확인했다. 추측 금지, 실측만.

## OpenAI (CORS) - 통과, 프록시 불필요

유효한 키로 브라우저에서 `api.openai.com`을 직접 호출하면 **200 + logprobs**를 읽을 수 있다. 401 에러 응답에만 `access-control-allow-origin`이 빠져 초기 테스트가 헷갈렸으나, 200에는 붙는다. 정적 사이트만으로 라이브 모드 가능. "서버 없음" 원칙 유지.

## Ollama (localhost) - 브라우저마다 갈림

배포된 HTTPS 사이트 → `http://localhost:11434`. 세 브라우저가 **각기 다른 이유로** 막는다:

| 브라우저 | 기본 상태 | 필요 조건 |
|---|---|---|
| Chrome / Edge (~70%) | `local-network-access` 권한이 **prompt** | `OLLAMA_ORIGINS` 설정 + 최초 1회 "허용" 클릭 |
| Firefox (~2.5%) | 통과 | `OLLAMA_ORIGINS`만 |
| Safari (~18%) | mixed content 차단 | HTTPS→HTTP 하드블록. **우회 불가** |
| (로컬 서빙 시) | 셋 다 통과 | `OLLAMA_ORIGINS`만 |

핵심 발견:
- 기획서가 "가장 큰 리스크"로 지목한 **Private Network Access**가 실제로 터졌다. Ollama는 `Access-Control-Allow-Private-Network` 헤더를 주지 않아, Chromium이 프리플라이트에서 `loopback` 접근을 막는다.
- 그러나 이는 하드 블록이 아니라 **권한 프롬프트**다. `navigator.permissions.query({name:"local-network-access"})`가 실제 Chrome에서 `"prompt"`를 반환 → 사용자가 허용하면 통과한다. Playwright에서 `grantPermissions(["local-network-access"])` 후 200 도달 확인.
- Safari는 mixed content라 배포 HTTPS 사이트에서는 원리상 불가. 로컬 서빙(`npx serve` 등)으로만 우회.

## 재현

```bash
ollama serve &   # 또는 OLLAMA_ORIGINS=https://5seoyoung.github.io ollama serve &
# 배포 사이트 콘솔에서:
fetch("http://localhost:11434/api/tags").then(r=>r.json()).then(console.log)
# 실패 시 콘솔의 에러 문구로 mixed content / CORS / PNA 구분
```

## 구현 시 UI 함의 (Ollama 모드)

- `OLLAMA_ORIGINS` 설정 안내는 필수 마찰. 연결 실패 시 진단 메시지로 (미실행 / 버전<0.12.11 / ORIGINS 미설정 / 브라우저 미지원) 구분.
- Chrome 사용자에게는 "브라우저가 로컬 네트워크 접근을 물으면 허용하세요" 안내.
- Safari 사용자에게는 로컬 서빙 안내 또는 "Chrome/Firefox 권장" 명시.
- 지원 브라우저를 UI에 밝힌다.

## 프라이버시 문구 (기획서 6절)

| 모드 | 문구 |
|---|---|
| 붙여넣기 | Nothing you paste leaves this page. |
| Ollama | Your document goes to your own Ollama on your machine. Nothing leaves it. |
| OpenAI | Your document and key go straight from your browser to OpenAI on your own account. They never touch our servers, but they do leave your machine. |
