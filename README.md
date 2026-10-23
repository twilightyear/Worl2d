# Worl2D

실제 지도 위를 포켓몬 DS처럼 한 칸씩 걸어 다니는 2D 도트 게임입니다.
OpenStreetMap 데이터를 2m 격자로 바꾼 뒤 도로·보도·공원·물·건물을 도트 타일로 그리고, 캐릭터는 그 격자 위를 이동합니다.

## 주요 기능

- **실제 지도 → 2m 격자**: OpenFreeMap 벡터 타일을 64×64칸 청크 단위로 계산해 칸마다 땅·풀·물·도로·건물 중 하나로 분류
- **도트 렌더러**: 칸당 16px, 정수 배율로 확대해 픽셀이 흐려지지 않음
- **가짜 3D 건물**: 비스듬한 시점과 원근을 적용하고 실제 건물 높이와 색을 반영. 벽돌·창문·문·지붕 그림과 그림자 표시
- **배치 규칙**: 보도·아스팔트 자동 구분, 가로등·가로수·공원 나무·벤치 자동 배치
- **캐릭터 이동**: 방향키/WASD로 한 칸씩 이동. 건물·물·물체와 충돌. 지도를 클릭하면 그 칸으로 순간이동
- **실제 지형 높낮이**: 공개 고도 데이터로 칸마다 해발 높이를 구해 4m 단위 층으로 나눔. 풀밭끼리 층이 다르면 턱(절벽)이 되어 한 층 아래로 뛰어내릴 수만 있고, 올라가려면 계단(지도 데이터의 계단 + 턱을 따라 자동 배치)을 이용. 도로·보도블록은 경사로로 보고 자유롭게 오르내림
- **다리·고가도로(층)**: 다리 위 도로는 높이 5m의 2층 상판으로 그림. 다리 끝에서 다리 방향으로 걸어 들어가면 경사로를 따라 올라가고, 옆으로 들어가면 다리 아래로 지나감(다리 아래에서는 캐릭터가 반투명하게 보임)

## 기술 스택

| 영역 | 사용 기술 |
| --- | --- |
| 프론트엔드 | React 19, TypeScript, Vite, MapLibre GL JS |
| 백엔드 | Spring Boot 4.1, Java 17, Gradle |
| 지도 데이터 | OpenFreeMap (OpenMapTiles 스키마, © OpenStreetMap contributors) |
| 지형 고도 | [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (AWS Open Data, Terrarium 형식) |

## 폴더 구조

```
Worl2D/
├── frontend/                 # React + Vite
│   ├── public/tiles/         # 게임에서 쓰는 타일셋 그림
│   └── src/
│       ├── components/       # MapView, ApiStatus
│       ├── map/              # 격자 규칙, 칸 종류 계산, 청크 저장
│       ├── game/             # 렌더러, 타일셋, 배치 규칙, 캐릭터
│       └── api/              # 백엔드 호출
└── backend/                  # Spring Boot
    └── src/main/java/...     # health, CORS 설정, 샘플 GeoJSON API
```

## 실행 방법

### 백엔드

```bash
cd backend
./gradlew bootRun        # Windows: gradlew.bat bootRun
```

`http://localhost:8080`에서 실행됩니다.

### 프론트엔드

```bash
cd frontend
npm install
npm run dev
```

`http://localhost:5173`에서 실행됩니다. 백엔드 없이도 게임 화면은 동작합니다. 이 경우 화면 아래에 API 연결 실패 표시만 나타납니다.

### 환경 변수 (선택)

`frontend/.env.local`에 넣으면 기본값 대신 사용합니다.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `http://localhost:8080` | 백엔드 주소 |
| `VITE_MAP_STYLE_URL` | OpenFreeMap 스타일 | 지도 스타일 주소 |

## 조작법

| 키 | 동작 |
| --- | --- |
| 방향키 / WASD | 한 칸 이동 |
| M | 게임 화면 ↔ 일반 지도 전환 |
| 지도 클릭 | 그 칸으로 순간이동 (건물·물 칸은 제외) |
| 마우스 휠, +/− 버튼 | 확대·축소 |

시작 위치는 주소 뒤에 `?at=경도,위도`를 붙여 바꿀 수 있습니다. 예: `http://localhost:5173/?at=126.958275,37.516663` (한강대교 북단)

## API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/health` | 서버 상태 확인 |
| GET | `/api/features/sample` | 샘플 GeoJSON FeatureCollection |

## 그림 출처

모두 CC0(퍼블릭 도메인)이라 상업적으로도 사용할 수 있습니다.

- [Kenney – RPG Urban Pack](https://kenney.nl/assets/rpg-urban-pack): 바닥, 보도, 물, 가로등, 나무, 벤치, 건물 벽·창문·문·지붕
- [Ninja Adventure Asset Pack](https://pixel-boy.itch.io/ninja-adventure-asset-pack) (Pixel-boy, AAA): 캐릭터

각 팩의 라이선스 파일은 `frontend/public/tiles/` 아래에 있습니다.

지형 고도는 Mapzen이 만든 [Terrain Tiles](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)(SRTM 등 공개 고도 데이터 모음)를 씁니다. 출처 표기 문구는 위 링크를 따릅니다.

## 라이선스

[MIT](LICENSE)
