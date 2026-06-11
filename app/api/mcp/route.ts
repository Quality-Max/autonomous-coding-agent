import { NextResponse } from 'next/server';
import { getConfiguredServers } from '@/lib/mcp';

export async function GET() {
  return NextResponse.json({ servers: getConfiguredServers() });
}
