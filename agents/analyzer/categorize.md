# Content Categorization

릴스 영상의 콘텐츠 유형과 주제/업종을 분류하는 프롬프트.
Claude Code가 대본 + 프레임 분석 결과를 바탕으로 직접 분류한다.

## 입력
- 대본 텍스트
- 프레임 분석 결과 (앞부분 10줄)
- 캡션

## 콘텐츠 유형 (content_type)

| 코드 | 설명 |
|------|------|
| `talking_head` | 카메라 보고 말하는 형태 |
| `vlog` | 일상/활동 기록 |
| `tutorial` | 방법/노하우 설명 |
| `showcase` | 제품/공간/작품 보여주기 |
| `skit` | 연기/코미디/상황극 |
| `interview` | 인터뷰/대담 |
| `montage` | 여러 장면 편집 (BGM 위주) |
| `before_after` | 전후 비교 |
| `listicle` | 리스트형 정보 나열 |
| `storytelling` | 스토리/경험담 |

## 주제/업종 (industry)

| 코드 | 설명 |
|------|------|
| `accommodation` | 숙박/호텔/펜션 |
| `food` | 요식/카페/맛집 |
| `beauty` | 뷰티/패션 |
| `fitness` | 운동/건강 |
| `tech` | IT/테크 |
| `finance` | 재테크/투자 |
| `education` | 교육/자기계발 |
| `travel` | 여행 |
| `lifestyle` | 라이프스타일 |
| `business` | 사업/창업/마케팅 |
| `entertainment` | 엔터테인먼트 |
| `other` | 기타 |

## 출력 형식

```json
{
  "content_type": "talking_head",
  "content_type_detail": "자기소개+스토리텔링",
  "industry": "accommodation",
  "industry_detail": "호텔/펜션 운영",
  "tags": ["숙박업", "창업", "라이프스타일"]
}
```

## 규칙
- content_type과 industry는 반드시 위 목록 중 택1
- detail은 자유롭게 세부 설명
- tags는 3~5개
