# 마이티 정책 학습

프로젝트의 실제 게임 엔진이 판을 진행하고, PyTorch가 네 정책을 각각 학습합니다. 웹은 선택된 가중치를 자바스크립트로 바로 계산합니다. 게임 플레이에는 Python, GPU, 모델 서버가 필요하지 않습니다.

## 설치와 실행

저장소 루트에서 Node.js 22 이상과 Python 3.12를 사용합니다. Windows PowerShell에서 CPU용 PyTorch를 설치하는 예입니다.

```powershell
uv venv --python 3.12 .venv
uv pip install --python .venv/Scripts/python.exe --index-url https://download.pytorch.org/whl/cpu -r lab/train-requirements.lock
.venv/Scripts/python.exe -B lab/test_training.py
.venv/Scripts/python.exe -B lab/train.py --smoke --objective win --seed 45 --out lab/local-runs/smoke
```

CUDA 12.6을 지원하는 NVIDIA 환경에서는 별도 가상환경에 같은 버전의 CUDA 휠을 설치한 후 `--device cuda`로 업데이트를 실행할 수 있습니다. 이 저장소의 배포 가중치는 CPU에서 학습했습니다. CUDA를 쓰더라도 브라우저 추론과 딜 생성은 CPU에서 실행됩니다.

```powershell
uv venv --python 3.12 .venv-cuda
uv pip install --python .venv-cuda/Scripts/python.exe --index-url https://download.pytorch.org/whl/cu126 -r lab/train-requirements.lock
.venv-cuda/Scripts/python.exe -B lab/train.py --device cuda --objective score --seed 93 --budget-minutes 60 --out lab/local-runs/score93
```

네 성향의 짧은 학습 실행과 기존 시드를 상대에 포함하는 방법입니다. 각 명령은 별도 실행 디렉터리를 사용합니다. 장기 학습 시간은 네 성향을 합친 예산이며, 시작한 배치는 평가까지 마칩니다.

```powershell
.venv/Scripts/python.exe -B lab/train.py --objective all --seed 731 --out lab/local-runs/run731
node lab/league.mjs seed-pool lab/local-runs/run731 lab/local-runs/run1731
.venv/Scripts/python.exe -B lab/train.py --objective all --seed 1731 --out lab/local-runs/run1731
node lab/league.mjs seed-pool lab/local-runs/run731 lab/local-runs/run2731
.venv/Scripts/python.exe -B lab/train.py --objective all --seed 2731 --out lab/local-runs/run2731
node lab/league.mjs select lab/local-runs/run731 lab/local-runs/run1731 lab/local-runs/run2731
```

선정 결과를 웹에 적용하려면 마지막 `select`에 `--publish`를 붙입니다. 각 목적의 후보를 모두 같은 검증 세트에서 비교하고 평균 효용이 가장 큰 체크포인트를 선택합니다. 동점은 명령에 적은 실행 디렉터리 순서와 이른 세대 순으로 결정합니다. 점검한 최종 테스트를 다시 모델 선발에 쓰면 새 평가 버전을 만들어야 합니다.

기존 체크포인트에서 새 실험을 시작할 수 있습니다. 아래 파일은 저장소에 실제로 포함된 체크포인트입니다. `fork`는 지정한 세대까지의 동결 정책과 기록을 빈 출력 디렉터리로 복사합니다.

```powershell
node lab/league.mjs fork lab/artifacts/run-731/win-step001.pt lab/local-runs/win-resumed
.venv/Scripts/python.exe -B lab/train.py --resume lab/local-runs/win-resumed/win-step001.pt --budget-minutes 60
node lab/selection-report.mjs lab/artifacts/run-731
```

학습 예산과 하이퍼파라미터는 `configs/train.json`, 상대 비율은 `configs/population.json`에 있습니다. `--alpha 0.25`와 `--lambda-risk 1`로 새로운 실행의 균형형 및 손실회피형 효용을 조절할 수 있습니다. 체크포인트 재개 시는 기록된 효용을 유지합니다.

## 정책과 결정 방식

한 번에 한 자리만 학습합니다. 다른 네 자리는 해당 배치 시작 시 동결된 규칙 AI와 과거 모델입니다. 다섯 자리에 균등 배분한 완결 경기를 모은 후 업데이트합니다. 전원 패스면 실제 게임처럼 재배분을 계속합니다. 마지막 카드를 낸 뒤 다른 자리가 마저 둔 결과까지 기다려 종결 효용을 마지막 결정에 붙입니다. 중간 보상은 0, 할인율은 1입니다.

- 승리형은 최종 팀 승패의 +1 또는 −1을 학습합니다.
- 정산점수형은 개인 영합 정산을 공통 상한 640으로 나눈 값을 학습합니다.
- 균형형은 기본값으로 승패 효용과 정산 효용을 각각 0.5배 합니다.
- 손실회피형은 정규화 정산이 음수일 때 그 손실 제곱의 0.5배를 추가 차감합니다.

네 정책의 학습 좌석만 확률적으로 행동합니다. 동결 신경망과 웹·검증은 같은 greedy 추론을 사용합니다. 훈련 시 확률 분포는 현재 가능한 후보들로만 정규화합니다. 비딩, 최종 공약, 세 장 묻기, 프렌드 지정, 카드 내기를 모두 학습합니다. 교환은 합법 최종 공약을 먼저 선택하고 그 공약에 조건부로 모든 286개 비순서 세 장 조합을 평가합니다.

공개 입찰, 현재 손패, 자신이 묻은 카드, 공개됐던 트릭 카드·점수·좌석과 공개 카드에서 알 수 있는 보이드 정보를 149개 수치로 인코딩합니다. 이력은 카드별 제출자와 획득 기록으로 요약합니다. 일부 세부 순서 정보는 요약에서 사라집니다. 16개 tanh 은닉 유닛에서 상태에 따른 행동 가중치와 개인 효용 예측값을 만듭니다. 합법 후보의 25개 특성과 전술 사전점수로 로짓을 계산합니다. 카드 내기의 전술 점수는 기존 공개 정보 기반 휴리스틱을 재사용합니다. 이 엔진이 처음 가진 판단을 지도학습으로 다듬은 뒤 masked PPO와 GAE로 갱신합니다. JS와 PyTorch의 수집 당시 로그 확률이 배치마다 맞는지 검사합니다.

`training.jsonl`에는 데이터 수, 파라미터 변화, 딜 시드, 학습 좌석, 상대 구성, 최종 효용을 기록합니다. `validation.jsonl`은 후보별 검증 5자리 결과입니다. `validation-comparison.json`은 같은 시드·좌석·상대·정책 난수 조건의 규칙형 기준과 짝지은 효용 차이 및 딜 단위 95% bootstrap 구간입니다. 후보 선발에 사용한 검증 구간은 독립 최종 평가 결과와 구분해서 읽어야 합니다. `lab/artifacts/champions.json`에는 배포 모델의 목표, 파일명, 시드, 세대, 버전과 해시가 들어갑니다.
