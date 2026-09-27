import { cx, initialsOf } from '../lib/format';

export interface AvatarProps {
  name: string;
  src?: string | null;
  size?: 'sm' | 'md' | 'lg';
  /** Presence indicator: renders a green dot for someone currently online. */
  online?: boolean;
  title?: string;
}

export function Avatar({ name, src, size = 'md', online = false, title }: AvatarProps): JSX.Element {
  const classes = cx('avatar', size === 'sm' && 'avatar--sm', size === 'lg' && 'avatar--lg');
  return (
    <span className={classes} title={title ?? name}>
      {src !== null && src !== undefined && src !== '' ? (
        <img src={src} alt="" loading="lazy" />
      ) : (
        <span aria-hidden="true">{initialsOf(name)}</span>
      )}
      {online ? <span className="presence-dot" aria-label="online" role="img" /> : null}
      <span className="visually-hidden">{name}</span>
    </span>
  );
}
