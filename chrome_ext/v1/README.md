# 릴스벤치 수집기 (Chrome 확장)

네이버 스마트스토어/브랜드스토어 상품 페이지에서 상품 정보·리뷰를 수집해 USP 분석에 활용합니다.

## 동작 방식
itemscout과 동일한 패턴:
1. 사용자가 상품 페이지에서 확장 아이콘 클릭
2. `chrome.scripting.executeScript`로 MAIN world에 코드 주입
3. `window.__PRELOADED_STATE__.simpleProductForDetailPage.A`에서 상품 정보 추출
4. 같은 도메인에서 `/i/v1/contents/reviews/query-pages` API 호출 → 리뷰 수집 (페이지당 30개)
5. JSON 다운로드 또는 클립보드 복사

**사용자 본인 세션이라 캡차/IP 차단 없음.**

## 설치
1. Chrome → `chrome://extensions/`
2. 우측 상단 "개발자 모드" 켜기
3. "압축해제된 확장 프로그램 로드" 클릭
4. 이 폴더(`chrome_ext/v1`) 선택

## 사용
1. 네이버 스마트스토어 상품 페이지 진입 (예: `https://smartstore.naver.com/patori/products/11980512927`)
2. 툴바의 "릴스벤치 수집기" 아이콘 클릭
3. "수집하기" 클릭
4. "JSON 다운로드" 또는 "리뷰 복사"

## 다음 단계
- `/api/products/import-from-naver` 엔드포인트 추가 (auth 필요)
- 백엔드에서 Gemini로 USP 자동 추출 → my_products 저장
- 확장에 "분석 + 저장" 버튼 추가 (Bearer 토큰 + POST)
