import { loadTeam } from '../../../../src/console/loaders.js';
import { TeamView } from '../../../../src/console/views/team.js';
import { merchantContext } from '../../_lib/server.js';

export const metadata = { title: 'Team' };

export default async function TeamPage() {
	const { api, merchantId, me } = await merchantContext('/team');
	return <TeamView {...await loadTeam(api, merchantId, me)} />;
}
