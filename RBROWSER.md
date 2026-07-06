# nptoy × RBrowser 통합 — 탐색 및 구현 기록

ROOT `.root` 파일을 nptoy 안에서 안전하게 열어보기 위해 RBrowser를 붙이기까지의
전체 과정 정리. 무엇을 원했고, 어떤 시도를 했고(장단점), 결국 무엇을 어떻게 구현했는지.

---

## 1. 무엇을 원했나

- nptoy는 여러 프로젝트의 검출기를 가져와 시뮬레이션을 돌리고, **검출기마다 `.root`
  데이터 포맷이 다름**. 이걸 분석 단계에서 **general하게** 다루고 싶었다.
- 구체 요구:
  - Files 탭에서 파일 선택 → `.root`면 **"RBrowser 열기"** 버튼으로 새 RBrowser 창.
  - 탐색 범위는 **`user/[계정]/`** 까지 (inputs + outputs 가 있는 그 폴더).
  - **유저당 RBrowser 1개** — 다른 `.root`를 열면 기존 창을 재사용.
  - 보안: 유저가 자기 폴더 밖(다른 유저·시스템)을 못 보게.

---

## 2. 먼저 알아낸 것 (설계를 가른 사실들)

- **nptool `.root`는 self-describing**: 트리는 항상 `SimulatedTree`, 브랜치마다
  `GetClassName()`이 담긴 클래스를 알려줌. 표준 브랜치(`Run`, `InitialConditions`,
  `InteractionCoordinates`, `TrackInfo`, `ReactionConditions`) + 검출기당
  `T<이름>Data`/`Raw`/`Physics`. → 검출기 이름 하드코딩 없이 브랜치 introspect로
  general 로더를 만들 수 있다.
- **결정적 한계**: nptool 검출기 클래스(`TSTARKData` 등)는 **커스텀 streamer**라
  **딕셔너리 없이는 역직렬화 불가**.
  - `uproot` → 실패 (`DeserializationError`)
  - `JSROOT` → 실패 (`Missmatch in TObject bytecount`, 동일 원인)
  - **오직 컴파일된 `libNPXXX`를 가진 C++ ROOT만** 검출기 데이터를 읽음.
  - 그래서 "브라우저 단독"으로는 검출기 브랜치를 못 그리고, RBrowser(서버측 ROOT)나
    백엔드 PyROOT가 필요하다.
- **RBrowser 성격**: ROOT 7 웹 GUI. `THttpServer`(civetweb)가 JSROOT+OpenUI5를 서빙.
  응답에 `X-Frame-Options`/CSP 없음(iframe 가능), loopback 바인딩, ws 경로
  `/win1/root.websocket`. **read-only가 아님** — 하단 `Enter command` 박스가
  **cling 임의 코드 실행**(파일 삭제·쓰기·네트워크 가능). → 격리가 필수.

---

## 3. 시도한 접근들 (장단점)

### 3-A. JSROOT 하이브리드 (브라우저에서 직접 렌더)
- **방식**: 브라우저에서 `JSROOT.js`로 `.root`를 열고, 검출기 히스토그램은
  백엔드 PyROOT(+`libNPXXX`)가 표준 `TH1`로 미리 뽑아 JSROOT이 렌더.
- **장점**: 서버측 ROOT 프로세스 불필요, 정적 서빙, 파일 브라우저가 아예 없어서
  **"연 파일만"이 기본값**. ws 프록시·프로세스 수명·파일시스템 노출 문제가 전부 없음.
- **단점**: JSROOT 단독으로 nptool 검출기 브랜치를 **직접 draw 불가**(위 한계). 결국
  백엔드 변환이 낀 **하이브리드**가 되고, "RBrowser UI 그 자체"는 아님.
- **검증**: `session.root` 구조 브라우징 + STARK 에너지 히스토그램(백엔드가 뽑은 `TH1F`)
  렌더 성공. 검출기 브랜치 직접 draw는 실패 확인.
- **판정**: 기능적으로 되지만 RBrowser UI가 필요 없을 때의 선택지. → 최종적으로 **버림**.

### 3-B. RBrowser 임베딩 + 폴더 잠금 (핵심 갈래)

RBrowser를 실제로 띄우되 **유저 폴더에만 가두는** 방법을 여러 개 실험.

#### (1) sandbox-exec 엄격 잠금 — macOS
- **방식**: 홈 전체 `deny file-read*` + 타겟 폴더만 `allow`. 프로세스 `cwd=/`로 둬서
  `getcwd()`가 차단된 조상 트리를 안 읽게 하는 트릭.
- **장점**: CLI 레벨로는 **완벽**. 타겟 파일만 읽히고 부모/형제/홈/`~/.ssh`/타 서비스
  DB 전부 `Operation not permitted`.
- **단점**: **RBrowser UI가 안 뜸(빈 셸)**. RBrowser 파일 브라우저는 `/`부터 walk하며
  홈 디렉토리를 읽어야 초기화되는데, 홈을 막으면 초기화 실패 → 파일 패널이 아예 안 생김.
- **판정**: macOS `sandbox-exec`로는 **"RBrowser 작동" + "폴더만"을 동시에 못 만족**.

#### (2) sandbox-exec targeted-deny — macOS
- **방식**: 홈은 열어두고 **민감 경로만** deny(`~/.ssh`, `web_service`, 셸 히스토리),
  working path를 유저 폴더로.
- **장점**: RBrowser UI **정상 작동**. 민감 데이터 읽기 차단.
- **단점**: **폴더 잠금은 아님** — 위로 탐색해 홈 구조(이름)는 보임(단 파일 읽기는 차단).
- **판정**: macOS **개발용**으로만 수용(보안 경계 아님).

#### (3) `RBrowserData::SetTopElement`로 트리 최상위를 폴더로
- **방식**: protected `fBrowsable`을 서브클래스로 뚫어 최상위 요소를 타겟 폴더로 교체
  (bare `RSysFile`, `RGroup`+`ProvideTopEntries` 둘 다 시도).
- **장점**: 성공하면 walk도 홈 접근도 불필요한 진짜 clean 잠금.
- **단점**: 컴파일·실행은 됐지만 **파일 패널이 렌더되지 않음**. RBrowser 위젯이 이 방식의
  re-root를 그대로 그리지 않음.
- **판정**: macOS 순정 API로는 미해결. → 버림.

#### (4) Docker 컨테이너 — Linux
- **방식**: `rootproject/root` 이미지에 타겟 폴더만 `-v …:/data:ro` 마운트하고 RBrowser 실행.
- **장점**: 컨테이너 안엔 ROOT + `/data`뿐 → **빈 최소 FS**, 진짜 격리. `:ro`라 삭제/수정
  불가. 위로 나갈 데가 없음.
- **단점**: 이미지 무거움(≈4 GB). amd64 이미지가 **arm64 맥에서 에뮬레이션** → ROOT 시작이
  **~0.08 s(네이티브) vs ~0.81 s(에뮬)** 약 **10배** 느려 인터랙티브 UI가 버벅임(배포는
  네이티브라 이 문제 없음).
- **검증**: `docker exec`로 확인 — 컨테이너 `/`=리눅스 FS, `/data`=진짜 nptool 파일,
  `/Users`(호스트) 없음, `/etc/passwd`=컨테이너 것, `/data`에 `rm`/쓰기 → `Read-only`.
- **판정**: 강한 격리지만 무거움.

#### (5) bubblewrap(`bwrap`) — Linux  ★ 채택 방식
- **방식**: 데몬·이미지 없이 **호스트에 이미 깔린 네이티브 ROOT**를 실행하되, 새 mount
  namespace에서 타겟 폴더만 `--ro-bind … /data`, ROOT/nptool 런타임 ro-bind, 나머지 부재,
  `nobody`로 드롭.
- **장점**: **가장 가벼움**(추가 오버헤드 ≈ 프로세스 + 수 ms). **에뮬레이션 무관 네이티브
  속도**. 데몬·이미지 빌드 불필요. **진짜 폴더 잠금**(command 박스로 `rm` 해도 무력).
- **단점**: **Linux 전용**(macOS 개발선 실행 불가). Ubuntu 24.04는 AppArmor가 비특권
  userns를 기본 차단 → **특권 런처(root)가 띄우고 안에서 `--uid`로 nobody 드롭**하는
  패턴으로 우회(호스트 보안 sysctl은 안 건드림).
- **검증**: colima Ubuntu 24.04 VM에서 실증 —
  ```
  bwrap 안(nobody):
    /            = bin data dev lib proc sbin tmp usr   (홈·etc·srv 없음)
    /data        = 유저 파일만
    호스트 민감파일/etc/passwd/home = No such file
    /data rm/쓰기 = Read-only file system
    보이는 프로세스 = 5개 (호스트 123개 안 보임)
  ```
- **판정**: nptoy 배포(Linux)의 **정답**. 가볍고 안전.

### 3-C. "nptoy 계정마다 Linux 계정" 아이디어 (기각)
- **방식**: nptoy 계정 → 실제 Linux 유저, Unix 퍼미션으로 격리.
- **단점**: 퍼미션은 "남의 private 파일"만 막을 뿐 **공유 호스트의 world-readable
  전체(`/etc`,`/usr`,`/opt`,`/proc`,타 서비스)가 다 보임**. command 박스=그 유저 권한의
  임의 코드 실행이라 표면이 넓음. RBrowser를 그 유저로 띄우려면 **특권 런처(setuid/sudo)**
  필요 → 그 자체가 공격면. "폴더만"은 결국 chroot/namespace를 또 붙여야 달성.
- **판정**: 계정(uid)은 소유권·쿼터 레이어로만, **격리는 namespace/컨테이너(=bwrap)**로.

### 왜 "컨테이너 per user"가 무겁지 않은가 (오해 정리)
- 컨테이너 ≠ VM. 격리 자체 오버헤드는 거의 0. **진짜 비용은 RBrowser 프로세스
  (~200–500 MB, ROOT 로드)** 이고 이는 맨몸이든 bwrap이든 동일. 이미지는 레이어 공유라
  N명이 써도 한 벌. **bwrap이면 이미지·데몬조차 없어 가장 가벼움.**

---

## 4. 결국 구현한 것

nptoy Files 탭에 **"RBrowser 열기"** — `.root` 미리보기에서 버튼 → 유저별 confine된
RBrowser를 `user/[계정]/`(inputs+outputs+saves+styles) 범위로 띄움. 유저당 1개,
다른 `.root`는 **같은 프로세스/같은 창 재사용**. 유휴 20분 후 자동 종료.

**Confinement(플랫폼 플러그블):**
- **Linux(배포)** → `bwrap` 진짜 잠금.
- **macOS(개발)** → `sandbox-exec` + cwd=유저폴더. 유저 폴더에서 열리지만 위 탐색은
  가능 — **dev 편의, 보안 경계 아님**(코드에 명시).

---

## 5. 어떻게 구현했나 (구체적)

### 변경 파일
| 파일 | 내용 |
|---|---|
| `backend/rbrowser.py` (신규) | 세션 매니저 + 플러그블 confine 런처 |
| `backend/main.py` | `POST /api/rbrowser/open`·`/close` + shutdown 훅 + import |
| `frontend/src/g4/api.js` | `rbrowserOpen(path)` 헬퍼 |
| `frontend/src/g4/FilesTab.jsx` | `openRBrowser()` 구현 (스캐폴드 채움) |

### 백엔드 `rbrowser.py` (핵심 로직)
- **레지스트리**: `_sessions[user_key] = {port, key, proc, last_used}`, `threading.Lock`.
- `open_for(user_key)`:
  1. 살아있는 세션 있으면 `last_used` 갱신 후 **재사용** 반환(→ 다른 `.root`도 같은 창).
  2. 없으면: 유저 폴더 보장 → 빈 포트 할당 → **부트 매크로** 작성 → `Popen(bash -lc cmd,
     cwd=…, start_new_session=True)` → stdout에서 RBrowser가 찍는
     `key=<…>` 파싱 + 포트 리스닝 대기.
- **부트 매크로** (`data/nptoy/.rbrowser/rb_<port>.C`, 차단영역 밖에 둬 sandbox 안에서 읽힘):
  ```cpp
  gEnv->SetValue("WebGui.HttpPort", <port>);
  gEnv->SetValue("WebGui.OnetimeKey", "no");     // 안정 URL
  gEnv->SetValue("WebGui.SingleConnMode", "no"); // 재접속 허용
  auto b = new ROOT::RBrowser();
  b->SetWorkingPath("<user_dir>");
  while (true) { gSystem->ProcessEvents(); gSystem->Sleep(50); } // stdin과 무관하게 서버 유지
  ```
- **cwd 트릭**: `SetWorkingPath`가 **깊은 경로에선 불안정**(루트/`cwd`로 fallback)이라,
  프로세스를 **`cwd=user_dir`로 기동** → RBrowser가 그 폴더에서 시작.
- **런처 커맨드**(`_launch_cmd`, `bash -lc`로 실행, `nptool.sh` source해서 검출기
  딕셔너리 로드 → 브랜치 draw도 가능):
  - **Linux**: `bwrap`로 ROOT/nptool/`/usr`… ro-bind + `--ro-bind <user_dir> /data`
    + `--tmpfs /tmp --proc /proc --dev /dev` + `--unshare-user,pid,ipc,uts,cgroup`
    + `--uid 65534 --gid 65534 --die-with-parent --chdir /data` → `root … --web=server`.
  - **macOS**: `sandbox-exec -f <profile>`(민감 경로만 deny) → `root … --web=server`,
    cwd=user_dir.
- **수명 관리**: 유휴 20분(`IDLE_TIMEOUT_SEC`) 넘거나 죽은 세션은 백그라운드 reaper가
  `killpg`. 매크로/프로파일 파일도 정리. 앱 shutdown 시 `shutdown_all()`.

### 백엔드 엔드포인트 (`main.py`)
- `POST /api/rbrowser/open` (auth): body의 `path`가 `.root`이고 유저 폴더 안인지
  `browse.resolve`로 검증 → `rbrowser.open_for(user_key)` → `{url, port}` 반환.
- `POST /api/rbrowser/close`: 유저 세션 종료.
- `@app.on_event("shutdown")` → `rbrowser_mod.shutdown_all()`.

### 프론트 (`FilesTab.jsx` + `api.js`)
- `.root` 미리보기에서만 뜨는 버튼(`preview.ext === 'root'`)은 이미 스캐폴드에 존재.
- `openRBrowser(path)`:
  ```js
  const win = window.open('', 'nptoy_rbrowser')   // 클릭 안에서 먼저 열어 팝업차단 회피
  const { url } = await rbrowserOpen(path)         // POST /api/rbrowser/open
  win.location.href = url                          // 고정 창이름 → 같은 창 재사용
  ```
- **창 재사용**: 고정 window name `'nptoy_rbrowser'` + 백엔드 프로세스 재사용 → 두 번째
  `.root`도 기존 창/기존 RBrowser로 열림.

### 검증 결과
- Files→`.root`→버튼 표시 ✓, 클릭→`POST /api/rbrowser/open 200`→RBrowser 프로세스 기동 ✓
- 다른 `.root` 호출 시 **같은 URL/포트 반환**(재사용) ✓
- RBrowser가 **`… > data > nptoy > user > <계정>`** 에서 열려 **inputs/outputs/saves/styles**
  만 표시 ✓ (macOS 개발 환경)

---

## 6. 남은 일 (배포 전)

현재 반환 URL은 RBrowser의 **loopback 직결**(`http://127.0.0.1:<port>/…`)이라
**브라우저와 서버가 같은 머신일 때(=로컬 개발)만** 새 창이 닿는다.

리눅스 서버 배포 시엔 RBrowser가 서버 loopback에 있고 브라우저는 원격이므로,
**nptoy 백엔드가 RBrowser를 리버스 프록시(HTTP + WebSocket)** 해야 한다.
- `rbrowser.py` `_info()`의 URL 생성 한 곳만 프록시 경로로 바꾸면 됨(프로세스·confine
  절반은 배포 무관하게 완성 — 코드에 `TODO(proxy)` 표시).
- 포털 프록시(`service_manager`)가 **ws 통과**를 지원해야 함(현재 HTTP 전용).
- RBrowser는 root-상대 경로(`/jsrootsys/`, `/rootui5sys/`)를 쓰므로 subpath 프록시 시
  경로 처리 필요.

---

## 부록 — 실측 수치 / 환경
- ROOT `6.38.00`, bubblewrap `0.9.0`, 테스트 VM: colima Ubuntu 24.04 (aarch64).
- ROOT 시작: 네이티브 arm64 **~0.08 s** vs 에뮬 amd64 **~0.81 s** (~10×).
- RBrowser: `WebGui.HttpLoopback`(loopback 바인딩), ws `= /win1/root.websocket`,
  `OnetimeKey`/`SingleConnMode` 조정 가능. `--web=server`는 브라우저 없이 서버만 기동.
