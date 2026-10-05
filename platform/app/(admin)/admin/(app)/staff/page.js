import { loadStaff } from '../../../../../src/console/admin/loaders.js';
import { StaffView } from '../../../../../src/console/admin/views/staff.js';
import { staffContext } from '../../../_lib/server.js';

export const metadata = { title: 'Staff' };

export default async function StaffPage() {
	const { api, staff } = await staffContext('/admin/staff');
	return <StaffView {...await loadStaff(api, staff)} />;
}
