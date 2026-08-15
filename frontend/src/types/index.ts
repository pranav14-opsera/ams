// Cross-feature shared types. Feature-specific types belong under that
// feature's own directory instead (src/features/<feature>/types.ts).

export interface ApiErrorResponse {
  error: string;
  message: string;
  request_id: string;
}
