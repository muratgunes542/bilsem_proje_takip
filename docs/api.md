# API V1.2

All endpoints use the Vercel Node server functions in `api/` and the shared router in `server/api/router.ts`. Authentication uses Better Auth's session cookie. Browser origins are restricted by `TRUSTED_ORIGINS`; there is no wildcard CORS policy. Except for `/api/auth/*`, endpoints require an active account. Roles are re-read from the user table for every request. A successful response is `{ "success": true, "data": ... }`; paged responses also include `pagination`. Errors use `{ "success": false, "error": { "code": ..., "message": ... } }`.

`page` defaults to 1 and `pageSize` to 20 (maximum 100) where pagination is listed. Validation errors return 400, missing sessions 401, insufficient permissions 403, missing records 404, and unexpected errors 500. Passwords and account credentials are never returned, except the generated temporary password in the one-time administrator teacher-creation response. Sessions are never returned.

## Routes

| Method and URL | Session / role | Inputs | Success |
| --- | --- | --- | --- |
| `GET /api/me` | Active user | — | Safe profile: id, name, email, role, active state, creation time |
| `GET /api/dashboard/summary` | Active user | — | Current-year student, teacher, project, unread notification and category summary |
| `GET /api/reports/overview` | Active user | optional `academicYearId`, admin-only `includeArchived=true` | Server-aggregated school totals, category/status/type distributions and year comparisons |
| `GET /api/reports/students` | Active user | pagination, optional `academicYearId`, `search`, `talentArea`, `advisorUserId`, `withoutProjects=true`, admin-only `includeArchived=true` | Paginated student enrollment participation counts; archived projects excluded by default |
| `GET /api/reports/teachers` | Active user | pagination, optional `academicYearId`, `search`, admin-only `includeArchived=true` | Separate created-project and advisor-project totals, unique advised students, categories, types and year contributions |
| `GET /api/reports/teachers/:id/projects` | Active user | pagination, `type=created\|advised`, optional `academicYearId`, admin-only `includeArchived=true` | Paginated teacher project drill-through list |
| `GET /api/reports/projects` | Active user | pagination, optional `academicYearId`, `categoryId`, `statusId`, `studentId`, `advisorUserId`, `participationType`, `search`, admin-only `includeArchived=true` | Server-paginated project report with distinct participant counts and advisors |
| `GET /api/project-options` | Active user | — | Active project categories, statuses and teacher options |
| `GET /api/admin/users` | ADMIN | `page`, `pageSize`, optional `search`, `role` | Safe user list + pagination |
| `PATCH /api/admin/users/:id` | ADMIN | `role` and/or `isActive` | Updated safe user; cannot deactivate own account or remove the last active administrator |
| `POST /api/admin/teachers` | ADMIN | `{ name, email }` | Creates a TEACHER via Better Auth, sets forced first password change; returns generated temporary password once |
| `POST /api/account/password` | Account owner | `{ currentPassword, newPassword, newPasswordConfirmation }` | Uses Better Auth change-password, revokes other sessions, clears forced-change state, audit logged |
| `POST /api/admin/students` | ADMIN | `{ bilsemNo, firstName, lastName, academicYearId, talentArea, advisorUserId? }` | Creates student and initial enrollment atomically; audit logged |
| `PATCH /api/admin/students/:id` | ADMIN | `{ bilsemNo, firstName, lastName }` | Updates identity fields; audit logged |
| `POST /api/admin/students/:id/enrollments` | ADMIN | `{ academicYearId, talentArea, advisorUserId? }` | Adds a year enrollment without changing earlier years; audit logged |
| `PATCH /api/admin/students/:id/enrollments/:enrollmentId` | ADMIN | `{ talentArea, advisorUserId? }` | Updates only that year's advisor/area and retains year/project links; audit logged |
| `GET /api/students` | Active user | pagination, `search`, `academicYearId`, `allAcademicYears=true`, `talentArea`, `advisorName` | Enrollment list + pagination; defaults to current academic year unless all years are requested |
| `GET /api/students/:id` | Active user | Student id | Profile and year-distinguished enrollments |
| `GET /api/students/:id/history` | Active user | Student id | Project history across academic years |
| `GET /api/academic-years` | Active user | — | Academic years, newest first |
| `GET /api/academic-years/current` | Active user | — | Current year (latest year fallback), or `null` |
| `POST /api/academic-years` | ADMIN | `{ name, startsOn: YYYY-MM-DD, endsOn: YYYY-MM-DD, isCurrent? }` | 201 + created year |
| `GET /api/projects` | Active user | pagination, optional `academicYearId`, `categoryId`, `statusId`, `studentId`, `advisorUserId`, `includeArchived` | Filtered project list + pagination |
| `POST /api/projects` | Active user | `{ title, description?, academicYearId, categoryId, statusId, participationType, teamName?, enrollmentIds }` | 201 + project id and non-blocking duplicate warnings |
| `GET /api/projects/:id` | Active user | Project id | Project, student members, advisors |
| `PATCH /api/projects/:id` | Creator or ADMIN | `{ title?, description?, statusId?, teamName? }` | Updated confirmation |
| `DELETE /api/projects/:id` or `POST /api/projects/:id/archive` | Creator or ADMIN | Project id | Archived confirmation |
| `POST /api/projects/:id/restore` | ADMIN | Project id | Restored confirmation |
| `GET /api/projects/:id/members` | Active user | Project id | Member enrollments |
| `POST /api/projects/:id/members` | Creator or ADMIN | `{ enrollmentId }` | Membership result; warning when submitted project needs review |
| `DELETE /api/projects/:id/members/:enrollmentId` | Creator or ADMIN | Path ids | Membership result; warning when submitted project needs review |
| `GET /api/notifications` | Active user | pagination, `unreadOnly=true` | Only notifications for the session user + pagination; unread subset when requested |
| `PATCH /api/notifications/:id/read` | Active user | Notification id | Read confirmation; other users' notifications are inaccessible |
| `POST /api/imports/preview?academicYearId=:id` | ADMIN | Raw XLSX body, official XLSX content type, `X-File-Name: roster.xlsx` | Preview batch id, row classifications, differences, and warnings; no student changes |
| `GET /api/imports/:batchId` | ADMIN | Batch id | Batch status, uploader, approval, counters and parser warnings |
| `GET /api/imports/:batchId/rows` | ADMIN | Batch id, pagination | Import rows and comparison details |
| `PATCH /api/imports/:batchId/rows/:rowId/advisor` | ADMIN | `{ advisorUserId }` | Resolves an unmatched teacher to an active teacher account |
| `POST /api/imports/:batchId/commit` | ADMIN | Batch id | Applies valid, resolved rows atomically; records approver and time |
| `POST /api/imports/:batchId/cancel` | ADMIN | Batch id | Cancels a pending preview without changing students |
| `ALL /api/auth/*` | Better Auth | Better Auth request | Better Auth response |

## Examples

```http
GET /api/students?search=Ali&page=1&pageSize=20
Cookie: better-auth.session_token=...
```

```json
{
  "success": true,
  "data": [{ "studentId": "…", "firstName": "Ali", "lastName": "Yılmaz", "academicYearId": "…", "talentArea": "Müzik" }],
  "pagination": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 }
}
```

```http
POST /api/projects
Content-Type: application/json
Cookie: better-auth.session_token=...
```

```json
{
  "title": "Enerji tasarrufu",
  "academicYearId": "year-id",
  "categoryId": "category-id",
  "statusId": "draft-id",
  "participationType": "TEAM",
  "enrollmentIds": ["enrollment-1", "enrollment-2"]
}
```

```json
{ "success": true, "data": { "projectId": "…", "conflicts": [] } }
```

```json
{ "success": false, "error": { "code": "UNAUTHORIZED", "message": "Oturum açmanız gerekiyor." } }
```

## Excel import

The upload is the raw `.xlsx` body (not multipart or JSON) with `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `X-File-Name`, and the target year in the query string. `IMPORT_MAX_FILE_BYTES` configures the limit (4 MiB default, up to 4 MiB for Vercel request limits). The ZIP container and workbook entries are checked before ExcelJS parsing; archive entry count, expansion size, compression ratio, row count and column count are bounded. Password-protected, corrupt, unsupported, and wrong-type files are rejected. Formula cells in mapped fields are never evaluated or trusted; those records are invalid. BİLSEM values accept digit-only text, safe non-negative integer cells, and zero-padding only when the number format is an unambiguous run of zero placeholders. Other custom formats are rejected for review.

Header mapping is order independent and supports Turkish spelling variants. Automatic teacher matching requires one exact active account-name match. Missing or ambiguous matches stay invalid until an administrator resolves the row by user id. Unexpected headers, extra sheets, and rows with no mapped values are reported in batch warnings. The workbook is parsed in memory and is not written to disk. Preview only persists the batch and its row results; student and enrollment records change only during the approval transaction. Rows missing from the selected year are reported and skipped. Approval rechecks the year, teacher accounts, and batch state; a second approval is rejected.

## Security and business rules

- The actor id is derived only from Better Auth's validated session; request body `userId`/`role` fields do not grant identity or permissions.
- Project edits and archive operations use the creator id; advisor assignments do not grant edit access. Administrators can manage all projects and restore archived projects.
- Team changes require active enrollments in the project's academic year and are audited. Existing service rules generate review warnings for submitted projects.
- Duplicate warnings use the configured category policy `ACADEMIC_YEAR_STUDENT_CATEGORY` (student + academic year + category) and do not prevent project creation.
- Student lists expose BİLSEM numbers because they are needed for authorized student lookup. Avoid using the list endpoint for public or anonymous access.
- Better Auth controls cookies and CSRF protections; trusted origins are explicitly configured. No additional permissive CORS headers are emitted by the API router.

## V1.6.1 notes

Better Auth enforces an 8-character minimum for email/password registration and password changes; existing passwords are not changed. The registration form confirms the password and reports Turkish validation errors.

Admin-created teacher accounts use Better Auth's supported `signUpEmail` API with a cryptographically generated temporary password. The role is fixed server-side as TEACHER, the password is returned once to the administrator, and the user must change it before any API access other than `/api/me` and the password-change route. Temporary passwords are excluded from audit records. Existing teachers cannot be reset by an administrator in this deployment.

This deployment has no email delivery provider configured. Email password reset remains unavailable. Better Auth's password-reset request requires `sendResetPassword`; do not enable it until an email provider and token storage design that prevents plaintext tokens in the database are configured. The admin UI makes this limitation explicit.

`users.must_change_password` is false for existing accounts by default. Newly admin-created teachers are marked true. This migration does not change existing sessions or passwords.

Manual student APIs accept digit-only BİLSEM numbers and store them as text, preserving leading zeroes. Existing legacy values are unchanged. Excel parsing accepts digit-only text and safe non-negative integer cells; a numeric cell receives zero-padding only when its number format is an unambiguous run of zero placeholders. Other custom formats are rejected for review.
