import React from 'react';
import { PrimaryButton } from './PrimaryButton';
import { SecondaryButton } from './SecondaryButton';
import { DangerButton } from './DangerButton';
import { GhostButton } from './GhostButton';

export function Button({ variant = 'primary', ...props }) {
	if (variant === 'secondary') return <SecondaryButton {...props} />;
	if (variant === 'danger') return <DangerButton {...props} />;
	if (variant === 'ghost') return <GhostButton {...props} />;
	return <PrimaryButton {...props} />;
}

export const ModernButton = Button;
