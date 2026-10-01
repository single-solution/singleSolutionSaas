import { StaffLoginView } from '../../../../../src/console/admin/views/auth.js';
import { one, redirectIfStaff } from '../../../_lib/server.js';

export const metadata = { title: 'Staff sign in' };

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function StaffLoginPage({ searchParams }) {
	await redirectIfStaff();
	const q = await searchParams;
	return <StaffLoginView next={one(q.next) ?? null} expired={one(q.expired) === '1'} reset={one(q.reset) === '1'} />;
}
