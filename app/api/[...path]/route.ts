import { handleApiRequest } from "@/lib/api/router";

type RouteContext = { params: Promise<{ path: string[] }> };

async function dispatch(request: Request, context: RouteContext) {
  const { path } = await context.params;
  return handleApiRequest(request, path);
}

export function GET(request: Request, context: RouteContext) {
  return dispatch(request, context);
}

export function POST(request: Request, context: RouteContext) {
  return dispatch(request, context);
}

export function PATCH(request: Request, context: RouteContext) {
  return dispatch(request, context);
}

export function DELETE(request: Request, context: RouteContext) {
  return dispatch(request, context);
}
