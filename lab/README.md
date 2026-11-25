# 마이티 AI 대국실

현재 테이블의 파토·공약 정산을 사용하는 기억형 세 모델과 후반 패 추론은 새 실험 기록에 정리했다. 아래는 이전 규칙으로 평가했던 모델과 재현 명령이다. [기억형과 후반 추론 재현](RECURRENT.md) · [현재 테이블 성적표](results-live/final_test.md)

게임에서 **혼자 연습하기 → 전체 AI 모델**을 열거나, **자리별 AI 선택**에서 네 모델을 따로 고른다. 온라인 방의 방장도 같은 방식으로 설정한다. 게임과 대국 평가기는 같은 자바스크립트 모델과 합법수 엔진을 사용한다. 게임에는 학습용 프로그램을 설치할 필요가 없다. [게임 열기](https://schoimath.github.io/mighty-online/) · [현재 탐색형을 포함한 독립 대국 성적표](results-v3/final_test.md)

## 실제 선발 과정

네 가지 목적별로 3개 초기 시드 × 4세대, 총 48개 후보를 만들었다. 후보별 학습 이력은 30판의 모방 워밍업과 세대당 80판의 PPO 대국으로 구성된다. 학습 좌석은 판당 하나다. 새 시드의 상대 풀에는 첫 시드의 과거 모델도 들어간다. 총 4,200판을 학습하고, 공통 검증 패 16개 × 5자리에서 후보마다 80판을 치렀다. 이 3,840판은 선발에만 사용했다.

| 탑재 모델 | 초기 시드 | 선발 세대 | 검증 기준 |
| --- | ---: | ---: | --- |
| 승리형 | 731 | 1 | 최종 팀 승률 |
| 정산점수형 | 2731 | 1 | 판당 개인 정산 |
| 균형형 | 1731 | 4 | 승패 효용과 정규화 정산을 0.5씩 반영 |
| 손실회피형 | 2731 | 3 | 음수 정산의 제곱에 0.5의 추가 벌점 |

동일 검증 효용이면 먼저 지정한 시드, 그다음 이른 세대를 선택했다. 브라우저에는 검증 후 고른 가중치만 담는다. 모형은 공개 트릭 기억, 자신의 패와 합법 행동 후보를 입력으로 쓰는 16차원 잔차 신경망이다. 모방 학습으로 출발해 후보 수의 기존 전술 점수를 PPO로 조정한다. 가치 예측에도 같은 관측을 쓴다. [선발된 가중치와 해시](artifacts/champions.json) · [48개 후보의 검증 효용](artifacts/selection-league.json) · [학습 설계·설치·재개](TRAINING.md)

## 재현하기

저장소 루트에서 실행한다. 대국, 등급 적합, 국면 진단은 Node.js 22 이상으로 가능하다. PPO 학습과 CPU 스모크는 Python 3.12와 잠긴 버전의 PyTorch를 사용한다. CLI는 저장소의 `.venv` 또는 `MIGHTY_PYTHON`으로 지정한 인터프리터를 찾는다. [설치 명령](TRAINING.md)

```sh
node lab/cli.mjs --help
node lab/cli.mjs validate-rules --config configs/rules.json
node lab/cli.mjs smoke --device cpu --seed 1
node lab/cli.mjs train --objective win --config configs/train.json --budget-minutes 60 --out lab/local-runs/win-long
node lab/cli.mjs train --objective score --budget-minutes 60 --out lab/local-runs/score-long
node lab/cli.mjs train --objective balanced --budget-minutes 60 --out lab/local-runs/balanced-long
node lab/cli.mjs train --objective downside_averse --budget-minutes 60 --out lab/local-runs/risk-long
node lab/league.mjs fork lab/artifacts/run-731/win-step004.pt lab/local-runs/continue-win
node lab/cli.mjs train --resume lab/local-runs/continue-win/win-step004.pt --budget-minutes 60
node lab/cli.mjs evaluate --manifest configs/benchmark.json --split validation --out lab/local-runs/evaluation
node lab/cli.mjs evaluate --manifest configs/benchmark.json --split final_test --out lab/local-runs/evaluation
node lab/cli.mjs rate --results lab/results-v3/final_test.jsonl
node lab/cli.mjs diagnose --suite configs/endgames.json --agent win --objective win
node lab/cli.mjs diagnose --suite configs/endgames.json --agent lab/artifacts/run-2731/score-step001.json --objective score
```

장기 학습할 때는 목적·예산·시드·검증 세트를 먼저 정한다. 공개한 최종 패로 후속 모델을 고르면 독립 검정이 성립하지 않으므로, 후속 모델에는 새로운 최종 시나리오를 예약한다. 전체 코드의 회귀 검증은 `node --test`로 실행한다.

## 성적표 읽기

이 성적표의 패와 정산은 평가 당시 설정으로 고정했다. 온라인과 연습 테이블에는 이후 첫 손패 무득점 자동 파토와 공약 연동 누적 정산이 추가됐다. [현재 테이블 규칙](../RULES.md)

현재 게임에서 여덟 전략형 AI는 같은 편이 앞선 트릭에 마이티를 쓸지 판단할 때 다른 자리의 뒷면 카드를 볼 수 없다. 마지막 자리에서 동료가 이기면 마이티를 아낀다. 뒤에 야당이 남아 있으면 자기 손과 공개된 트릭에 맞는 패 배분을 최대 20개 만들어 야당이 실제로 낼 수 있는 카드로 뒤집을 위험을 추정한다. 숨은 프렌드는 주공을 동료로 알지만 주공은 프렌드가 밝혀진 뒤에야 동료로 판단한다. 무작위형은 합법수 전체에서 추첨한다. [플레이 정책](partnership-policy.js) · [초구·마지막 자리·기루다 컷 재현 패](../tests/partnership-policy.test.mjs)

별도 검증 패 16개와 최종 패 48개를 사용했다. 각 패와 첫 자리, 재배분 난수열, 나머지 네 정책의 배치와 좌석별 난수를 고정하고 관심 있는 한 자리의 모델만 교체했다. 이를 다섯 자리 모두에서 반복했다. 최종 2,160판의 독립 표본 단위는 **패 48개**다. 각 패의 다섯 자리와 모든 모델을 함께 복원추출해 95% 구간을 구했다. 새로운 상대 구성으로 탐색형이 들어간 패 12개를 따로 포함했다.

두 Elo는 독립 패 4개를 한 묶음으로 놓고 모델 간 승수 차이·개인 정산 합계 차이의 부호를 각각 집계한다. 동률을 0.5승으로 두고, 기준 탐색형을 1500에 고정해 정규화된 Bradley–Terry 등급을 일괄 적합했다. 원시 승률은 내가 이긴 편이 된 비율이고 정산은 실제 개인 순정산이다. 둘은 카드 획득 수와도 단위가 다르다. 대국 시간은 측정 장비의 실행 속도에 따라 변한다. [원시 최종 대국](results-v3/final_test.jsonl) · [배경별·역할별·상대별 통계](results-v3/final_test.summary.json) · [평가 설정](../configs/benchmark.json)

## 후반 한 수 진단

8번째 트릭의 실제 엔진 국면 두 가지를 쓴다. 다른 자리의 미공개 카드 두 장을 바꾼 뒤, 두 배분에서 **처음부터 같은 공개 행동이 모두 합법**이고 해당 좌석의 관측도 동일한지 확인한다. 지정한 두 세계의 확률과 고정된 협력형 후속 정책 아래에서 모든 합법 후보를 끝까지 두어 평균 효용을 정확히 계산한다. 뒤에 둘 사람도 매번 자기 관측만 본다. 두 배분에 준 확률은 진단용 가정이다. 실제 카드 배분 전체의 사후확률을 추정하는 도구는 아니다.

예를 들어 가능성이 70대 30인 두 세계에서 각각 다른 수가 이기면, 70% 쪽을 택한 판단 손실은 0이다. 그 판의 숨은 패가 30% 쪽으로 밝혀져도 사전 판단은 그대로다. 평가기는 확률 예제와 실제 후반 수의 후보별 효용을 모두 출력한다. [규칙 명세](../RULES.md) · [진단 국면](../configs/endgames.json)

## 첫 배포 모델의 개발·실행 기록

Windows x64, Intel Core i7-8700, Node 24.15.0, Python 3.12.9, CPU PyTorch 2.8.0에서 실행했다. 별도 CUDA 휠을 사용하는 학습 경로도 제공한다. 이번 배포 가중치는 모두 CPU에서 만들었다. 첫 시드 학습은 51초, 병렬 실행한 추가 두 시드는 각각 65초, 66초였다. 첫 시드의 실행시간을 확인하고 독립 시드를 세 개로 늘렸으며, 이 결정을 내릴 때 이전 최종 후보 패의 집계 결과는 보지 않았다. 최종 보고에는 새로 예약한 2675000~2675047번 패만 사용했다.

- **실력**. 탐색형의 개인 승률은 68.3%, 학습형은 62.5~63.3%였다. 같은 패에서 승리형의 승률은 탐색형보다 5.8%p 낮았다(개별 95% 구간 −10.4~−0.8%p). 네 학습형 모두 이 표본에서 자기 목적의 평균 효용이 탐색형보다 낮았다. 탐색형을 기본값으로 유지한다.
- **속도**. 학습형은 한 수 추론 p95가 0.254~0.277ms, 탐색형은 26.028ms였다. 이 시간은 엔진이 관측을 만든 뒤의 정책 실행시간이다. 인간 상대 승률은 측정하지 않았다.
- **추가 입찰 실험**. 기존 성적표를 고정한 뒤 새로운 개발 패 24개에서 기존 탐색형과 입찰 후보 세 가지를 480판 비교했다. 기존 탐색형의 66.7%·+13.06점에 대해 후보들은 65.0~66.7%·+12.37~+12.76점이었다. 세 후보 모두 배포 모델로 선발되지 않았다. [후속 개발 실험 원자료](results/hybrid-development.json)
- **검증**. 최종 2,160판에서 불법수와 시간 초과는 각각 0건이었다. CPU 스모크에서 실제 PPO 가중치 변화와 저장을 확인했다. 같은 관측에 대해 브라우저용 정책과 평가기가 같은 수를 내는지, 경기 종료 뒤 보상이 마지막 결정까지 전달되는지, 정산 합이 0인지 검증했다. 실제 브라우저 두 곳에서 한 방에 접속해 모델 설정을 공유하고, 네 학습형을 각각 다른 자리에 앉혀 열 트릭을 진행했다. [성적표와 신뢰구간](results/final_test.md) · [학습 로그 예시](artifacts/run-731/training.jsonl) · [국면별 진단 결과](results/diagnostics.json)
