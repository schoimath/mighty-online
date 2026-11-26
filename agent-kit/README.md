# 마이티 AI 개발 키트 v1

카드 배분, 파토, 합법수, 개인별 칩 정산은 게임 엔진이 처리합니다. 모델은 자기 차례에 관측값을 받고 수 하나를 반환합니다. 기존 **협력형**이 이 규격으로 실행됩니다. [타입 정의](api.d.ts) · [독립 예제](starter.js) · [협력형 구현](cooperative.js)

## 내 모델로 플레이하기

Node.js 22 이상에서 저장소 루트를 작업 폴더로 사용합니다. 별도 패키지 설치 없이 실행할 수 있습니다. [starter.js](starter.js)를 자신의 프로젝트로 복사해 `my-agent.mjs`로 저장하고 `id`, `label`, `decide`를 바꾸세요.

```sh
npm run ai:check -- ./my-agent.mjs 3 42
npm run ai:practice -- ./my-agent.mjs
```

첫 명령은 경매·교환·프렌드·카드 내기를 각각 검사한 뒤, 같은 배분으로 다섯 자리를 돌아가며 기존 협력형 네 명과 겨룹니다. 위 예시는 3개 배분으로 15판을 치릅니다. `wins`는 모델의 승리 횟수, `netChips`는 개인 정산 합계입니다. 잘못된 수나 예외가 발생하면 검사는 실패합니다.

두 번째 명령으로 표시된 로컬 주소를 열고 **혼자 연습하기 → 전체 AI 모델**에서 내 모델을 고르세요. 미리보기에는 브라우저에서 읽을 수 있는 단일 ES 모듈을 전달합니다. 여러 소스나 가중치를 사용하면 추론에 필요한 내용까지 한 파일로 번들하세요. 기본 예제를 바로 시험하려면 두 명령의 파일 경로에 `./agent-kit/starter.js`를 넣으세요.

## 입력과 응답

`decide({apiVersion, seed, observation})`은 동기 함수입니다. `seed`는 이번 선택의 난수 시드입니다. 매 호출이 독립적이므로 필요한 기억은 `playedTricks`, `trick`, `bidHistory`에서 복원하세요.

관측값에는 내 손패, 좌석별 남은 장수, 공개된 입찰과 카드 순서, 규칙, 역할, 선택지가 들어 있습니다. 좌석은 0~4번입니다. `knownKitty`와 `discarded`는 주공에게만 채워집니다. 공개되기 전 프렌드는 `friend: null`이며, 본인이 프렌드이면 `selfRole`에 표시됩니다. `playedTricks`에는 사람들이 앞서 보드에서 볼 수 있었던 카드가 기록됩니다.

| 단계 | 반환하는 수 | 선택 기준 |
| --- | --- | --- |
| `bid` | `{type:'pass'}` 또는 `{type:'bid', suit:'H', points:15}` | `choices.canPass`, `choices.bids` |
| `discard` | `{type:'discard', cards:['S2','D3','C4']}` | 손패의 서로 다른 세 장. 최종 공약을 바꾸면 `choices.contracts`의 항목을 `contract`로 함께 반환 |
| `friend` | `{type:'friend', ...call}` | `choices.friends` 중 하나 |
| `play` | `{type:'play', ...move}` | `choices.plays` 중 하나. 조커의 요구 무늬와 조커콜 여부도 포함 |

카드 무늬는 S·H·D·C, 조커는 JK, 노기루다는 N입니다. 실전에서 세팅 선언은 게임의 별도 판정 절차가 맡습니다. 개발용 대국은 10트릭을 끝까지 플레이합니다.

## Python 등에서 학습하기

`node agent-kit/environment.mjs`를 자식 프로세스로 실행합니다. 표준 입력에 JSON 한 줄을 보내면 표준 출력으로 JSON 한 줄이 돌아옵니다. 프로세스 하나에서 여러 판을 순서대로 실행할 수 있습니다.

```python
import json, subprocess

with subprocess.Popen(["node", "agent-kit/environment.mjs"], stdin=subprocess.PIPE,
                      stdout=subprocess.PIPE, text=True, encoding="utf-8") as game:
    def send(command):
        game.stdin.write(json.dumps(command) + "\n")
        game.stdin.flush()
        return json.loads(game.stdout.readline())

    turn = send({"op": "reset", "seed": 42, "policySeed": 123, "firstSeat": 0})
    while not turn["done"]:
        action = model.decide(turn["observation"])  # 여기에 내 모델을 연결
        turn = send({"op": "step", "action": action})
        if "error" in turn:
            raise ValueError(turn["error"])
    print(turn["outcomes"])  # 좌석 순서로 win, settlement, role, captured
    game.stdin.close()
```

`reset`에 게임과 같은 `rules`를 넘길 수 있습니다. 배분 시드와 선택 시드를 고정하면 같은 행동열을 재현할 수 있습니다. 잘못된 수를 보내면 오류가 돌아오며 같은 차례에 다시 선택할 수 있습니다. 온라인 추론은 같은 입력과 출력을 사용하는 동기 ES 모듈로 제공합니다.

## 온라인 모델로 등록하기

1. 모델을 저장소 안에 넣고 [registry.js](registry.js)에 정적 import와 배열 항목을 추가합니다. `id`는 영문 소문자로 시작하는 48자 이내의 소문자·숫자·밑줄 조합입니다. 기존 ID와 예약어 `random`은 사용할 수 없습니다.
2. 개발 키트 검사와 `npm test`를 실행합니다. 운영 등록 전에는 추론이 항상 유한 시간에 끝나는지, 계정·네트워크·파일 접근 없이 동작하는지도 검토하세요. 브라우저와 게임 서버에서 같은 코드를 실행합니다.
3. 운영자는 같은 소스의 `chip-hand` 서버 함수를 먼저 배포한 뒤 웹을 배포합니다. 등록된 모델이 연습과 방장의 **전체 AI 모델**에 표시되고 랜덤 배정에도 포함됩니다. 외부 모델이 예외를 내거나 합법수가 아닌 수를 반환하면 실전에서는 협력형이 그 차례를 대신합니다.
