import { http, HttpResponse } from "msw";
import { env } from "@/env";
import teamsFixture from "@/test/fixtures/wizard/teams.json";
import createAgentSuccessFixture from "@/test/fixtures/wizard/create-agent-success.json";

const base = env.NEXT_PUBLIC_API_BASE_URL;

/** Default happy-path handlers for the Register Agent wizard's own API calls — individual tests layer `server.use(...)` overrides on top (error/timeout scenarios) per MSW's own request-handler-override convention. */
export const wizardHandlers = [
  http.get(`${base}/api/v1/teams`, () => HttpResponse.json(teamsFixture)),
  http.post(`${base}/api/v1/teams`, async ({ request }) => {
    const body = (await request.json()) as { name: string };
    return HttpResponse.json({ id: "33333333-3333-3333-3333-333333333333", name: body.name, memberCount: 0 }, { status: 201 });
  }),
  http.post(`${base}/api/v1/agents`, () => HttpResponse.json(createAgentSuccessFixture, { status: 201 })),
  http.post(`${base}/api/v1/agents/:id/retry-validation`, () => HttpResponse.json({}, { status: 202 })),
];
