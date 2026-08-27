import React from 'react';

export function IconCheck({ size = 14, className = '' }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}>
			<polyline points="20 6 9 17 4 12" />
		</svg>
	);
}
