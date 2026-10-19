# lol-live

LCK / Worlds 경기를 **Claude Code 안에서** 보는 mod입니다. Claude Code를 평소처럼 쓰면서 보면 됩니다.
터미널과 데스크톱 앱(macOS·Windows·Linux)에서 같은 폴더 하나로 동작하고, Python 같은 별도 설치는 필요 없습니다.

- **상태줄**: `⚔ T1 12:8 GEN · 골드 +3.2k T1 · 포탑 5:3 · 용 2:1 · 바론 0:1 · 18초 전`
  경기가 없으면 `⚔ 다음: GEN vs IG 10/24 02:00` (한국 시간)
- **실시간 패널**: 경기가 시작되면 저절로 열리고 10초마다 갱신, 경기가 끝나면 닫힘.
  점수판·포지션별 선수(챔피언 한국어 이름, KDA, CS, 골드)·관측 기록, `지연 ±5`·`알림` 버튼.
- **알림**: 킬·포탑·억제기는 창 안 토스트, 세트 시작·종료(승자, 시리즈 점수)·경기 종료·바론·드래곤(종류)·
  골드 역전·한타는 OS 알림까지. 연속으로 나온 킬은 **한 교전으로 묶어** 끝난 뒤 한 번에 알려 줍니다:
  `💥 한타 T1 3:1 GEN → T1 승리 (7:2) · 처치 Faker 2·Gumayusi · 사망 Keria / Canyon·Chovy·Ruler · T1 바론`
  Claude Code 창을 여러 개 열어도 같은 OS 알림은 한 번만 보냅니다.
- **질문**: `/lol 지금 누가 유리해?` → 방금 받은 점수판 데이터를 붙여 Claude에게 묻습니다.

> **알림에는 세트/경기 승패가 나옵니다.** 스포일러가 싫으면 `/lol alerts off`.

## 설치

Claude Code 터미널 세션의 프롬프트에서:

```
/plugin install lol-live --marketplace ThunderConch/lol-live
```

`Add marketplace?`에 `y`, 설치 범위는 맨 위의 user를 Enter로 고르면 이후 모든 세션에서 켜집니다.

셸에서:

```
claude plugin install lol-live --marketplace ThunderConch/lol-live
```

데스크톱 앱(`/plugin`이 없는 곳): 프롬프트 옆 **+** → **Plugins** → **Add marketplace**에
`ThunderConch/lol-live` → **Add plugin**. 터미널에서 user 범위로 설치했다면 데스크톱 앱의 로컬 세션에도 함께 로드됩니다.

## 명령

| 명령 | 동작 |
|---|---|
| `/lol` | 전체 스냅샷(점수판·선수·기록) |
| `/lol panel` | 패널 열기 (직접 닫으면 그 세트 동안은 다시 자동으로 열지 않음) |
| `/lol on` / `off` | 상태줄·패널·알림 전체 켜기/끄기, 다음 세션에도 유지 |
| `/lol alerts [on\|off]` | 알림만 켜기/끄기 (인자 없으면 전환) |
| `/lol demo [on\|off]` | 합성 데모 데이터로 미리보기 |
| `/lol status` · `list` · `help` | 현재 상태와 설정 · 일정(한국 시간) · 도움말 |
| `/lol game auto` | 진행 중 경기 자동 선택 (기본) |
| `/lol game <게임ID> [경기ID] [--at UTC시각]` | 특정 세트 고정, 과거 시각 재생 |
| `/lol delay N` | 추가 지연 0~120초 |
| `/lol <질문>` | 현재 스냅샷을 근거로 Claude에게 질문 |

## 알아 둘 점

- 데이터는 lolesports.com 웹사이트가 쓰는 **비공식** 읽기 전용 API입니다(웹사이트가 브라우저에 공개하는 키 사용).
  Riot 공식 지원이 아니며 형식이 바뀌면 동작이 멈출 수 있습니다.
- API는 현재보다 약 60초 전 데이터만 줍니다. 방송과 맞지 않으면 `/lol delay`나 패널의 `지연 ±5`로 맞추세요.
- 경기 중 10초, 경기가 없으면 5분, 오류 때 60초마다 조회합니다.
- 기록과 한타 요약은 **두 조회 사이의 숫자 변화**로 만듭니다. 누가 누구를 잡았는지처럼 데이터에 없는 내용은 만들지 않습니다.
- 진행 중 경기의 실시간 형식(getLive)은 라이브 경기에서 아직 검증되지 않았습니다.

## 개발

```
claude plugin validate .
claude plugin test .
```
