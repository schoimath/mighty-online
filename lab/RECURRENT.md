# 현재 테이블 규칙으로 학습한 마이티 AI

이 문서는 기억형 승률·정산점수·균형을 처음 학습한 실험 기록이다. 현재 게임에서는 **기억형 · 균형**을 고를 수 있고, 자리마다 공약 탐색형이나 협력형도 배치할 수 있다. 온라인 방에서는 방장이 고른다. [게임 열기](https://schoimath.github.io/mighty-online/) · [현재 기억형의 추가 학습과 대국 성적](TABLE-TRAINING.md)

학습에 쓰지 않은 원본 패 64개로 다섯 좌석을 교체하며 4,160판을 평가했다. 기억형 승률은 이전 승리형의 58.4%에서 60.6%로, 기억형 득점의 개인 평균 정산은 이전 정산점수형의 +6.56점에서 +6.82점으로 올랐다. 기억형 균형의 목적 효용은 0.4188에서 0.4298로 올랐다. 세 차이의 개별 95% 신뢰구간은 모두 0을 포함한다. 기본 탐색형의 승률은 65.9%였다. 다음 학습 실험에서는 탐색형을 동료·상대 풀과 교사에 포함한 뒤 새로운 홀드아웃 패에서 다시 비교할 수 있다. [짝비교와 역할별 표](results-live/final_test.md) · [교사 적용 전후 비교](results-live/ablation/final_test.md) · [교차 대국](results-live/crossplay.md)

## 무엇을 학습하는가

| 기억형 모델 | 한 판이 끝난 뒤 해당 자리의 보상 |
| --- | --- |
| 승률 | 자기 팀이 이기면 1, 지면 0 |
| 정산점수 | 그 자리의 실제 개인 정산점수 ÷ 640 |
| 균형 | 0.7 × 팀 승리 지표 + 0.3 × (개인 정산점수 ÷ 640) |

공약 연동식, 주공·프렌드·야당의 몫, 네 가지 배율, 초구·막구 규칙과 무득점 파토를 게임방과 같은 코드로 처리한다. 행동 사이의 보상은 0이고, 기본 할인율은 1이다. 자기대국의 매 판에서 목표와 상대를 먼저 정하고, 주공과 프렌드는 실제 입찰과 선언으로 결정한다. 점수 정규화 척도와 균형형 가중치는 학습 설정에 기록한다. [테이블 규칙](../RULES.md) · [학습 설정](../configs/recurrent.json) · [환경과 최종 효용](live-game.js)

GRU는 자기 손패, 공개된 입찰·선언·트릭, 자기에게 알려진 역할과 합법수 후보를 읽는다. 행동 확률과 가치 예측은 같은 관측에서 계산한다. 주공이 13장 중 세 장을 묻을 때는 먼저 최종 공약을 고르고 그 공약에 조건부로 286개의 조합을 비교한다. 브라우저에서는 각 자리의 메모리를 따로 보관하고, 마지막으로 승인된 행동까지 반영한다. 워커가 중간에 실패해도 같은 메모리와 난수로 재시도한다. 새 판과 전원 패스 재배분에서 메모리를 초기화한다.

PPO는 한 자리의 연속된 의사결정을 한 시퀀스로 다룬다. 매 배치의 최신 정책에서 완결된 판을 수집하고, 이전 체크포인트는 상대나 동료 자리에 배치한다. 기본 상대 비중은 무작위·휴리스틱 30%, 현재 동결 정책 40%, 과거 정책 30%다. 과거 정책이 없는 첫 배치는 사용할 수 있는 두 집단 사이에서 비례 재분배한다. 정책 갱신에 사용한 유효 결정 수, 수집 시점 JS와 학습 시점 PyTorch의 로그확률 오차, 가중치 변화량은 학습 기록에 남는다. [학습 코드](recurrent_train.py) · [브라우저 추론](recurrent.js) · [PPO 원논문](https://arxiv.org/abs/1707.06347)

## 후반 한 수와 교사 학습

기본 샘플러는 자기 패, 공개된 카드, 남은 장수와 무늬 추종 정보를 만족하는 공동 배치를 제안한다. 학습 샘플러는 320개 학습 딜에서 얻은 카드 소유 정답 8,452개로 이 제안에 쓰이는 가중치를 학습했다. 두 방식 모두 가능한 최초의 10장, 바닥 3장, 버림패와 그 뒤의 플레이를 게임 엔진으로 다시 실행해 관측이 일치하는 배치만 남긴다. 주공이 실제로 확인한 바닥·버림패도 보존한다. [샘플러](belief.js) · [카드 소유 실험](artifacts/belief/validation.json)

한 수 분석기는 같은 배치들에서 각 행동의 최종 효용을 구한 뒤 평균을 비교한다. 가장 유리해 보이는 수를 첫 표본에서 고르고, 독립 표본의 쌍차이로 원래 수보다 나은지 확인한다. 출력에는 **모형에 따른 추정 행동 손실**, 표본 수, 표준오차·구간, 추정에 쓴 후속 정책과 표본 거부 횟수가 있다. 신뢰구간은 지정한 패 분포와 후속 정책 아래의 표본 오차를 나타낸다. 정확한 최적 전략에 대한 후회나 균형의 취약성은 측정하지 않는다. [분석기](analyze-move.mjs) · [국면 예시](../examples/observation.json)

교사 학습은 후보별 효용 추정치를 확률로 바꾸고, 차이를 재확인한 국면을 골라 별도 지도학습으로 모방한다. PPO의 종료 보상은 그대로 사용한다. 게임에서 고를 수 있는 후반 추론형은 아홉 번째 트릭에 독립 표본까지 좋아진 수만 채택하고 나머지 차례에는 협력형 전술을 쓴다. 공약 탐색형은 주공이 바닥을 확인한 직후, 현재 기루다·노기루다·네 장 이상 가진 무늬의 공약을 같은 가상 패들에서 비교한다. 개인 정산 증가분에서 표준오차 하나를 뺀 값이 양수일 때 공약을 바꾼다. [후반 플레이 정책](belief-policy.js) · [공약 탐색](contract-search.js)

## 실행과 재개

공개·사적 관측을 분리하고 자리마다 행동을 고르는 설계에는 팀원이 비대칭 정보를 갖는 순차 게임의 연구를 참고했다. 각 행동을 모든 가상 배치에서 먼저 평균내는 이유는 배치마다 숨은 패를 안 것처럼 다른 최선 수를 고르는 오류를 피하기 위해서다. 이번 실험은 5인 마이티에서 동결한 상대군을 대상으로 실력과 한 수의 손실을 측정한다. [팀 게임의 비대칭 정보](https://proceedings.mlr.press/v162/carminati22a.html) · [정보집합 몬테카를로 탐색과 strategy fusion](https://eprints.whiterose.ac.uk/id/eprint/75048/)

저장소 루트에서 Node.js 22 이상과 Python 3.12, CPU PyTorch 2.8.0을 사용한다. 아래 Node 명령은 저장소의 `.venv` 또는 `MIGHTY_PYTHON`으로 지정한 인터프리터를 찾는다. 학습 출력 경로는 새 디렉터리를 지정한다. [Python 환경 설치](TRAINING.md)

```sh
node lab/cli.mjs train-recurrent --config configs/recurrent-smoke.json --out lab/local-runs/gru-smoke
node lab/cli.mjs train-recurrent --config configs/recurrent.json --out lab/local-runs/gru
node lab/cli.mjs train-recurrent --resume lab/artifacts/recurrent-aux/checkpoint.pt --out lab/local-runs/gru-next --updates 2 --budget-seconds 180
node lab/cli.mjs evaluate-live --config configs/live-eval.json --split validation --out lab/local-runs/check-validation
node lab/cli.mjs analyze-move --input examples/observation.json --checkpoint lab/artifacts/recurrent-aux/best-balanced.json --objective balanced --continuation checkpoint
node --test
```

학습 체크포인트는 모델·optimizer·난수 상태·상대 풀·규칙·효용·소스 지문을 보관한다. 분석기와 브라우저는 내보낸 JSON 가중치를 사용한다. `--continuation checkpoint`는 후속 다섯 자리에서 같은 체크포인트를 쓰되 가상 배치마다 각자의 사적 이력으로 기억을 복원한다. `--continuation heuristic`으로 후속 휴리스틱을 고정한 비교도 가능하다.

전체 대국에서는 관심 있는 자리 한 곳만 바꾸고 다른 네 정책, 최초 배분, 각 자리의 난수를 고정한다. 좌석 다섯 개는 같은 원본 패 한 묶음으로 집계한다. 역할별 수치는 후보가 입찰과 프렌드 선택에 미친 영향도 포함한다. 계약과 역할을 먼저 고정한 카드 플레이 성적, 실제로 서로 다른 기억형이 만난 교차 대국은 따로 확인할 수 있다. [계약·역할 고정 성적](results-live/fixed-play/final_test.md) · [전체 대국 설정과 시드](../configs/live-eval.json)

다음 명령으로 동결한 모델의 최종 성적표를 별도 폴더에 재현할 수 있다. `live-loss.mjs`의 추정 양상과 샘플러의 카드 소유 예측 정확도는 별도 지표다. [후반 한 수의 손실과 판단 보류 비율](results-live/action-loss.md) · [패 추론 실험과 재현 명령](BELIEF.md)

```sh
node lab/live-evaluate.mjs --split final_test --out lab/local-runs/final
node lab/live-evaluate.mjs --mode fixed_play --split final_test --out lab/local-runs/fixed-play
node lab/live-evaluate.mjs --split crossplay --out lab/local-runs/crossplay
node lab/live-evaluate.mjs --agents heuristic --checkpoints configs/live-ablations.json --split final_test --out lab/local-runs/ablation
node lab/live-loss.mjs
```

## 체크포인트 재현

공개 가중치 후보를 만든 두 CPU 실행은 각각 완결된 2,160판(목표당 720판)을 학습했다. 시드 58621은 24,869개 결정과 76.05초, 시드 95731은 24,786개 결정과 54.23초를 기록했다. 각 시간에는 1차 검증이 포함된다. 두 번째 실행은 첫 번째 실행의 목표별 동결 모델 세 개를 상대 풀에 추가했다. 1차 검증은 업데이트마다 같은 24개 검증 딜을 다섯 자리·세 목표에서 재생했다. 두 시드의 후보는 별도의 72개 검증 딜에서 다시 비교했다. 승률형과 균형형은 시드 95731의 12번째 업데이트, 득점형은 같은 시드의 11번째 업데이트를 선택했다. [시드별 전체 검증 결과](artifacts/recurrent/selection.json)

아래 명령은 저장소 루트에서 실행한다. `python`은 `lab/train-requirements.lock`을 설치한 인터프리터다. 새 출력 폴더를 사용하면 기존 체크포인트도 보존된다.

```sh
python -B lab/recurrent_train.py --out lab/local-runs/seed58621
python -B lab/recurrent_train.py --seed 95731 --external lab/local-runs/seed58621/best-win.json --external lab/local-runs/seed58621/best-score.json --external lab/local-runs/seed58621/best-balanced.json --out lab/local-runs/seed95731
python -B lab/recurrent_select.py lab/local-runs/seed58621/checkpoint.pt lab/local-runs/seed95731/checkpoint.pt --out lab/local-runs/ppo-selected
python -B lab/recurrent_teacher.py --checkpoint lab/local-runs/ppo-selected/checkpoint.pt --teachers lab/artifacts/belief/teachers.jsonl --out lab/local-runs/teacher-selected --ablation lab/local-runs/ablation
```

교사 단계는 승률형 9개·득점형 29개·균형형 20개의 별도 훈련 정보집합에서 해당 자리의 관측 이력을 재생한다. 각 관측에서 합법적 후보별 추정 효용을 softmax로 변환한 교사 분포를 모방한다. 실제 교사 온도는 승률·균형형 0.12, 득점형 0.012이며 신뢰도 가중치를 곱한다. 비교를 위해 증류 전후 정책은 같은 72개 검증 딜·다섯 자리·상대 구성에서 평가한다. 검증 효용이 증가한 목표만 가중치를 교체한다.

CPU 재현 검사에서는 연속 2회 업데이트와 1회 업데이트 후 재개한 결과의 모든 파라미터, optimizer, RNG, 학습·검증 경기별 결과가 일치했다. 벽시계 시간은 실행마다 달라진다.

```sh
python -B lab/recurrent_train.py --config configs/recurrent-smoke.json --updates 2 --out lab/local-runs/smoke-a
python -B lab/recurrent_train.py --config configs/recurrent-smoke.json --out lab/local-runs/smoke-b
python -B lab/recurrent_train.py --resume lab/local-runs/smoke-b/checkpoint.pt --updates 1
python -B lab/check_recurrent_resume.py lab/local-runs/smoke-a/checkpoint.pt lab/local-runs/smoke-b/checkpoint.pt
```

교사 적용 전후의 검증 승률은 58.06%에서 58.89%로, 균형 효용은 0.40279에서 0.40675로 올라 이 두 후보를 채택했다. 득점형의 개인 평균 정산은 +0.875점에서 +0.608점으로 낮아져 PPO 체크포인트를 유지했다. 이 수치는 선택에 사용한 72개 딜의 결과다. 배포용 모델 묶음의 SHA-256은 `de101aab3b7626043670d29d467b0d46f421b8ee84a81a64f5f3641619681955`다. [선택된 모델 기록](artifacts/recurrent-aux/validation.json) · [학습·교사 비교 원시 로그](artifacts/recurrent-aux/training.jsonl)
